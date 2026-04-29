/**
 * Scenario orchestrator — runs the closed-loop lifecycle for a
 * single scenario execution.
 *
 *   1. retrieve similar past postmortems from the experience base
 *      (for Emily to consult pre-action; also used downstream by the
 *      scorer for observed retrieval_used determination)
 *   2. inject the fault via the registered InjectorRunner
 *   3. watch detector conditions concurrently until either
 *      fixed_when satisfies, regressed_when trips, or time budget
 *      elapses
 *   4. invoke the postmortem hook (stubbed in Phase-1-Week-1: caller
 *      provides a Postmortem in the request; Phase-1-Week-2 wires
 *      Emily's event stream)
 *   5. score via the breakage scorer
 *   6. upsert postmortem + outcome label into the experience base
 *   7. run the injector's Undo to restore the environment
 *
 * All output goes into a ScorecardRun record the caller renders
 * into the scorecard JSON.
 */

import { randomUUID } from 'node:crypto';
import type {
  DetectorCondition,
  Postmortem,
  Scenario,
} from '../types/index.js';
import { InjectorRegistry, type Undo } from '../injector/index.js';
import { ExpressionEvaluator } from '../detector/index.js';
import {
  retrieveSimilarTo,
  upsertPostmortem,
  type RetrievalResult,
} from '../experience-base/index.js';
import { scoreScenario, type ScoreResult } from '../scorer/index.js';
import type { ClusterClient } from '../speculative-exec/cluster-client.js';
import {
  setActive,
  clearActive,
  getActiveHypotheses,
} from './active-scenario.js';

export interface OrchestratorDeps {
  client: ClusterClient;
  registry: InjectorRegistry;
  evaluator: ExpressionEvaluator;
}

export interface RunRequest {
  scenario: Scenario;
  /**
   * Two modes:
   *
   *   stub mode   — postmortem provided directly by caller. Used for
   *                 smoke testing the pipeline without a real Emily.
   *
   *   await mode  — postmortem undefined. Runner sets the scenario
   *                 active, injects, and waits for Emily (or any
   *                 other client) to POST her structured postmortem
   *                 to /capture-postmortem. Times out at the
   *                 scenario's time_budget_s; falls back to an
   *                 inconclusive-outcome postmortem on timeout.
   */
  postmortem?: Postmortem;
}

export interface ScorecardRun {
  scenario_id: string;
  incident_id: string;
  ran_at: string;
  injected: boolean;
  detector: {
    fixed: boolean;
    regressions: string[];     // expressions that tripped
    elapsed_ms: number;
  };
  retrieval: {
    k: number;
    consulted: string[];
    /** From observed action-pattern matching, not self-report. */
    used: string[];
  };
  score: ScoreResult;
  /** Hypotheses Emily emitted during the run, in emission order. */
  hypotheses?: Array<{
    primary_category: string;
    confidence: number;
    emitted_at: string;
  }>;
  undo: {
    attempted: boolean;
    succeeded: boolean;
    error?: string;
  };
  error?: string;
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async run(req: RunRequest): Promise<ScorecardRun> {
    const { scenario } = req;
    const incidentId = `${scenario.id}-${randomUUID()}`;
    const ranAt = new Date().toISOString();
    const isAwaitMode = !req.postmortem;

    const result: ScorecardRun = {
      scenario_id: scenario.id,
      incident_id: incidentId,
      ran_at: ranAt,
      injected: false,
      detector: { fixed: false, regressions: [], elapsed_ms: 0 },
      retrieval: { k: 0, consulted: [], used: [] },
      score: {
        total: 0,
        axes: {
          detected: { earned: 0, possible: 0, detail: {} },
          diagnosed: { earned: 0, possible: 0, detail: {} },
          fixed: { earned: 0, possible: 0, detail: {} },
          no_regressions: { earned: 0, possible: 0, detail: {} },
        },
        retrieval_used: [],
      },
      undo: { attempted: false, succeeded: false },
    };

    let undo: Undo | null = null;
    let retrieved: RetrievalResult[] = [];
    const timeBudgetMs = scenario.scorer.time_budget_s * 1000;

    // In await mode, register the scenario as active BEFORE injection
    // so a fast Emily can't race us (she'd POST /capture-postmortem
    // before setActive and get 409 Conflict).
    const activeSlot = isAwaitMode ? setActive(scenario.id, timeBudgetMs) : null;

    // Track whether the normal happy-path persist ran. If it didn't
    // (injection failure, detector crash, etc.), the `finally` block
    // persists a run-failed stub so every /run call produces exactly
    // one DB row. Previously, injection failures left the scorecard
    // showing the error but no postmortem row — silent data loss.
    let persisted = false;

    try {
      // 1. Retrieve from experience base. Use the scenario's
      //    symptom_class + ground-truth category as query key — in
      //    production Emily would supply her own query, but the
      //    orchestrator-side retrieval is what the scorer's
      //    observed retrieval_used check pattern-matches against.
      const retrievalQueryText = `${scenario.symptom_class} ${scenario.ground_truth.primary_category}`;
      retrieved = await this.retrieveForScenario(scenario, retrievalQueryText).catch(() => []);
      result.retrieval.k = retrieved.length;
      result.retrieval.consulted = retrieved.map((r) => r.id);

      // 2. Inject fault.
      undo = await this.deps.registry.inject(scenario);
      result.injected = true;

      // 3. In parallel: watch detectors AND (in await mode) wait
      //    for Emily's postmortem capture. Both bounded by
      //    time_budget_s.
      const detectorStart = Date.now();
      const detectorPromise = this.watchDetectors(scenario, timeBudgetMs);

      let postmortem: Postmortem;
      if (isAwaitMode && activeSlot) {
        // Race detector + capture. If detector completes first, we
        // still wait briefly for the capture to arrive (Emily's
        // postmortem typically arrives just after she confirms the
        // fix). If capture never arrives, fall back to
        // inconclusive stub.
        const detectorResult = await detectorPromise;
        result.detector.fixed = detectorResult.fixed;
        result.detector.regressions = detectorResult.regressions;
        result.detector.elapsed_ms = Date.now() - detectorStart;

        const remainingMs = Math.max(0, timeBudgetMs - result.detector.elapsed_ms);
        const captured = await Promise.race([
          activeSlot.awaitCapture(),
          new Promise<null>((r) => setTimeout(() => r(null), remainingMs)),
        ]);

        if (captured) {
          postmortem = captured;
          postmortem.incident_id = incidentId;
          postmortem.scenario_id = scenario.id;
        } else {
          // No postmortem arrived. Synthesize an inconclusive one so
          // the scoring path still runs and the report shows this
          // scenario timed out.
          postmortem = synthesizeTimeoutPostmortem(scenario, incidentId);
        }
      } else {
        // Stub mode — caller-supplied postmortem, run detectors
        // once to gather observations.
        postmortem = { ...req.postmortem! };
        const detectorResult = await detectorPromise;
        result.detector.fixed = detectorResult.fixed;
        result.detector.regressions = detectorResult.regressions;
        result.detector.elapsed_ms = Date.now() - detectorStart;
        postmortem.incident_id = incidentId;
        postmortem.scenario_id = scenario.id;
      }

      // Attach retrieval info to the postmortem we're about to score
      // + persist.
      postmortem.retrieval_consulted = result.retrieval.consulted;

      // 4. Score.
      //
      // Snapshot the hypotheses Emily emitted mid-investigation so
      // the scorer can flag channel disagreement (last hypothesis vs
      // final postmortem). Empty array when the scenario predates
      // the tool or Emily skipped emitting.
      const hypotheses = getActiveHypotheses().map((h) => ({
        primary_category: h.primary_category,
        confidence: h.confidence,
        emitted_at: h.emitted_at,
      }));
      result.hypotheses = hypotheses;
      const scoreResult = scoreScenario({
        scenario,
        observation: {
          detected: postmortem.actions_taken.length > 0,
          fixed: result.detector.fixed,
          regressionEvents: result.detector.regressions,
        },
        postmortem,
        retrieved: retrieved.map((r) => ({
          id: r.id,
          actions: r.postmortem.actions_taken.map((a) => ({ tool: a.tool })),
        })),
        hypotheses,
      });
      result.score = scoreResult;
      result.retrieval.used = scoreResult.retrieval_used;

      // The stored record reflects what actually happened, not what
      // Emily self-reported.
      postmortem.retrieval_used = scoreResult.retrieval_used;

      // 5. Derive outcome from detector signals.
      postmortem.outcome = result.detector.regressions.length > 0
        ? 'regressed'
        : result.detector.fixed
        ? 'resolved'
        : 'inconclusive';

      // 6. Persist.
      await upsertPostmortem(postmortem, {
        source: 'scenario',
        runMetadata: {
          ran_at: ranAt,
          score: result.score,
          detector: result.detector,
          retrieval: result.retrieval,
        },
      }).catch((err) => {
        console.warn('[orchestrator] postmortem persist failed:', err);
      });
      persisted = true;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    } finally {
      // Always clear active slot + attempt undo so the next run
      // starts clean.
      if (activeSlot) activeSlot.clear();
      else if (isAwaitMode) clearActive(scenario.id); // defensive
      if (undo) {
        result.undo.attempted = true;
        try {
          await undo();
          result.undo.succeeded = true;
        } catch (err) {
          result.undo.succeeded = false;
          result.undo.error = err instanceof Error ? err.message : String(err);
        }
      }

      // Safety-net persist. If the happy path didn't reach step 6
      // (injection throw, unhandled error in detector/scoring), we
      // still want a DB row so the scorecard reflects the run. The
      // stub carries the error message and scores zero on all axes.
      if (!persisted) {
        const failureStub = synthesizeRunFailurePostmortem(
          scenario,
          incidentId,
          result.error ?? 'unknown run failure (persist skipped without throw)',
        );
        failureStub.retrieval_consulted = result.retrieval.consulted;
        await upsertPostmortem(failureStub, {
          source: 'scenario',
          runMetadata: {
            ran_at: ranAt,
            score: result.score,
            detector: result.detector,
            retrieval: result.retrieval,
            run_error: result.error,
            injected: result.injected,
          },
        }).catch((err) => {
          console.warn('[orchestrator] failure-stub persist failed:', err);
        });
      }
    }

    return result;
  }

  private async retrieveForScenario(
    scenario: Scenario,
    queryText: string,
  ): Promise<RetrievalResult[]> {
    // Reuse retrieveSimilarTo by constructing a minimal
    // Postmortem-shaped key object. Scope to incident-log +
    // production sources so scenario-source postmortems don't
    // dominate retrieval during scenario runs.
    const stubKey: Postmortem = {
      scenario_id: scenario.id,
      incident_id: '',
      detected_at: new Date().toISOString(),
      final_diagnosis: queryText,
      primary_category: scenario.ground_truth.primary_category,
      secondary_categories: scenario.ground_truth.secondary_categories,
      confidence: 0,
      actions_taken: [],
      fix_applied: '',
      what_did_not_work: [],
      time_to_diagnose_s: 0,
      time_to_fix_s: 0,
      side_effects_observed: [],
      retrieval_consulted: [],
      retrieval_used: [],
      outcome: 'inconclusive',
    };
    return retrieveSimilarTo(stubKey, { sources: ['incident-log', 'production'], k: 3 });
  }

  // (retrieveForScenario lives above)

  /**
   * Race fixed_when AND regressed_when conditions. Returns as soon
   * as the full fixed_when set satisfies OR any regressed_when trips,
   * or when the time budget elapses.
   */
  private async watchDetectors(
    scenario: Scenario,
    timeBudgetMs: number,
  ): Promise<{ fixed: boolean; regressions: string[] }> {
    const { evaluator } = this.deps;

    // Wrap fixed_when: all conditions must satisfy (sustained-for-s
    // enforced per condition).
    const fixedPromise: Promise<'fixed' | 'timeout'> = (async () => {
      for (const cond of scenario.detector.fixed_when) {
        const ok = await evaluator.evaluateSustained(cond, { timeoutMs: timeBudgetMs });
        if (!ok) return 'timeout';
      }
      return 'fixed';
    })();

    // Wrap regressed_when: any condition tripping is a regression.
    // Each regressed_when condition polls concurrently.
    const regressions: string[] = [];
    const regressionPromises = scenario.detector.regressed_when.map(
      async (cond: DetectorCondition) => {
        const tripped = await evaluator.evaluateSustained(cond, {
          timeoutMs: timeBudgetMs,
          pollIntervalMs: 2000,
        });
        if (tripped) regressions.push(cond.expression);
        return tripped;
      },
    );

    // First to complete settles the race.
    const winner = await Promise.race([
      fixedPromise,
      ...regressionPromises.map(async (p) => {
        const t = await p;
        return t ? 'regressed' : 'timeout';
      }),
    ]);

    return {
      fixed: winner === 'fixed',
      regressions: [...regressions],
    };
  }
}

function synthesizeTimeoutPostmortem(scenario: Scenario, incidentId: string): Postmortem {
  const now = new Date().toISOString();
  return {
    scenario_id: scenario.id,
    incident_id: incidentId,
    detected_at: now,
    final_diagnosis: `[timeout] Emily did not submit a postmortem within the scenario's ${scenario.scorer.time_budget_s}s time budget.`,
    primary_category: 'application-error-uncaught-exception',
    secondary_categories: [],
    confidence: 0,
    actions_taken: [],
    fix_applied: '',
    what_did_not_work: [],
    time_to_diagnose_s: 0,
    time_to_fix_s: 0,
    side_effects_observed: [],
    retrieval_consulted: [],
    retrieval_used: [],
    outcome: 'inconclusive',
  };
}

/**
 * Synthesize a postmortem representing a run that failed before a
 * real postmortem could be produced — typically an injector throw or
 * some other orchestrator-level error. Emily never saw the fault;
 * Emily wasn't even given a chance to act. Marked as an explicit
 * framework-side failure so the scorecard includes the row but
 * doesn't blame Emily for it.
 */
function synthesizeRunFailurePostmortem(
  scenario: Scenario,
  incidentId: string,
  errorMessage: string,
): Postmortem {
  const now = new Date().toISOString();
  return {
    scenario_id: scenario.id,
    incident_id: incidentId,
    detected_at: now,
    final_diagnosis: `[framework-error] Scenario run failed before Emily could produce a postmortem: ${errorMessage.slice(0, 500)}`,
    primary_category: 'framework-error',
    secondary_categories: [],
    confidence: 0,
    actions_taken: [],
    fix_applied: '',
    what_did_not_work: [],
    time_to_diagnose_s: 0,
    time_to_fix_s: 0,
    side_effects_observed: [],
    retrieval_consulted: [],
    retrieval_used: [],
    outcome: 'inconclusive',
  };
}
