/**
 * Speculative-execution controller. The mechanism that makes
 * "fix live, record after" safe.
 *
 * Usage pattern (conceptual — the actual integration wraps Emily's
 * tier-2 tools so she doesn't opt in):
 *
 *   const result = await controller.executeWithRevert({
 *     scenarioId,
 *     primary,
 *     run: async () => await kubectlPatch(primary, patch),
 *     probes: makeDefaultProbes(primary.namespace),
 *     windowMs: 30_000,
 *   });
 *
 *   if (result.type === 'reverted') {
 *     // tell Emily her action was reverted + the mechanical reason
 *   } else if (result.type === 'held') {
 *     // action stuck; normal happy path
 *   } else if (result.type === 'paused-for-approval') {
 *     // N=2 limit hit — block further retries on this scenario,
 *     // surface analysis + human-review request
 *   }
 *
 * The controller keeps a per-scenario attempt counter. When it hits
 * MAX_REVERT_ATTEMPTS (=2), the next call pauses and returns
 * 'paused-for-approval' without running the mutation — Emily's loop
 * must present her analysis of why previous attempts failed and
 * request human review before further action.
 */

import { MAX_REVERT_ATTEMPTS, type ResourceRef, type RevertOutcome, type Snapshot } from './types.js';
import type { ClusterClient } from './cluster-client.js';
import { snapshot } from './snapshot.js';
import { revert } from './revert.js';
import { watchForRegression, type MetricProbe } from './watcher.js';

export interface ExecuteWithRevertOptions<TResult> {
  /** Null for production usage; a scenario ID during scenario runs. */
  scenarioId: string | null;
  /** The primary resource being mutated. Associated resources are auto-captured. */
  primary: ResourceRef;
  /** The actual mutation. Called AFTER snapshot; return value is forwarded if no revert. */
  run: () => Promise<TResult>;
  /** SLO probes used to detect regression. */
  probes: MetricProbe[];
  /** SLO-watch window. Plan default: 15-60s per action class. */
  windowMs: number;
  /** Optional poll interval override for the watcher. */
  pollIntervalMs?: number;
}

export class SpeculativeController {
  private attempts = new Map<string, number>();

  constructor(private readonly client: ClusterClient) {}

  /**
   * Execute `run` with snapshot + watch + auto-revert wrapping.
   * Enforces N=2 attempt limit per scenario.
   */
  async executeWithRevert<TResult>(
    opts: ExecuteWithRevertOptions<TResult>,
  ): Promise<
    | { type: 'held'; attempt: number; result: TResult; snapshot: Snapshot }
    | (RevertOutcome & { snapshot?: Snapshot })
  > {
    const key = opts.scenarioId ?? '__production__';
    const attempt = (this.attempts.get(key) ?? 0) + 1;

    if (attempt > MAX_REVERT_ATTEMPTS) {
      // N=2 limit: refuse to run a third time without human gate.
      return {
        type: 'paused-for-approval',
        attempt,
        reason:
          `Scenario ${opts.scenarioId} exceeded ${MAX_REVERT_ATTEMPTS} auto-revert ` +
          `attempts. Emily must present analysis of prior failed attempts and ` +
          `request human review before further action on this scenario.`,
      };
    }

    this.attempts.set(key, attempt);

    // 1. snapshot
    const snap = await snapshot(this.client, opts.primary, {
      scenario_id: opts.scenarioId,
    });

    // 2. run the mutation
    let runResult: TResult;
    try {
      runResult = await opts.run();
    } catch (err) {
      // Tool threw — don't watch, just bubble up. No mutation applied
      // (or it half-applied and the caller has to clean up; the
      // snapshot is available for a manual revert).
      throw err;
    }

    // 3. watch SLOs
    const regression = await watchForRegression({
      probes: opts.probes,
      windowMs: opts.windowMs,
      pollIntervalMs: opts.pollIntervalMs,
    });

    // 4a. no regression: hold
    if (!regression) {
      return { type: 'held', attempt, result: runResult, snapshot: snap };
    }

    // 4b. regression: revert
    await revert(this.client, snap);
    return {
      type: 'reverted',
      attempt,
      revertedAt: new Date().toISOString(),
      event: regression,
      snapshot: snap,
    };
  }

  /**
   * Reset the attempt counter for a scenario. Called by the scenario
   * runner between reps so each rep gets a fresh N=2 budget.
   */
  resetScenario(scenarioId: string): void {
    this.attempts.delete(scenarioId);
  }

  /**
   * Observability: current attempt count for a scenario. Useful for
   * the scorer + reports.
   */
  attemptsFor(scenarioId: string): number {
    return this.attempts.get(scenarioId) ?? 0;
  }
}
