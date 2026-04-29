/**
 * Overall scenario scorer. Composes the per-axis scores into a
 * normalized [0, 1] total and a detailed per-axis breakdown for the
 * scorecard.
 *
 * The four axes (plan §3):
 *   detected         - did Emily notice the problem within time budget
 *   diagnosed        - did primary/secondary categories match ground truth
 *   fixed            - did detector.fixed_when conditions satisfy
 *   no_regressions   - did detector.regressed_when stay false, weighted
 *                      by reversibility of the actions Emily took
 *
 * This module is pure logic. The caller supplies the raw observations
 * (detected yes/no, fixed yes/no, regression observations, Emily's
 * postmortem, the retrieved postmortems). Nothing in here calls the
 * cluster or the DB.
 */

import type { ActionRef, Scenario } from '../types/index.js';
import type { Postmortem } from '../types/index.js';
import { scoreDiagnose } from './diagnose.js';
import {
  determineRetrievalUsed,
  type RetrievalCandidate,
} from './retrieval-used.js';

export interface Observation {
  detected: boolean;
  fixed: boolean;
  /** Any regressed_when condition that went true during the run. Empty = no regressions. */
  regressionEvents: string[];
}

/** A hypothesis Emily emitted via `emit_hypothesis` during investigation. */
export interface HypothesisObservation {
  primary_category: string;
  confidence: number;
  emitted_at: string;
}

export interface ScoreInputs {
  scenario: Scenario;
  observation: Observation;
  postmortem: Postmortem;
  retrieved: RetrievalCandidate[];
  /**
   * Hypotheses Emily emitted during the run, in emission order. The
   * scorer uses the LAST hypothesis to flag disagreement when it
   * differs from postmortem.primary_category — the disagreement
   * corpus is training data per plan §4, not a penalty on Emily.
   */
  hypotheses?: HypothesisObservation[];
}

export interface AxisScore {
  earned: number;
  possible: number;
  detail: Record<string, unknown>;
}

export interface ChannelDisagreement {
  /** True when the scorer observed a mismatch between channels. */
  flagged: boolean;
  /** Last hypothesis Emily emitted, or null if she never emitted. */
  last_hypothesis?: string;
  /** Category in her final postmortem. */
  postmortem_category: string;
  /** Short human-readable explanation of why it's flagged or not. */
  reason: string;
}

export interface ScoreResult {
  total: number;
  axes: {
    detected: AxisScore;
    diagnosed: AxisScore;
    fixed: AxisScore;
    no_regressions: AxisScore;
  };
  /** Populated from observed action-pattern matching, NOT from Emily's self-report. */
  retrieval_used: string[];
  /**
   * Flagged when Emily's last emitted hypothesis disagrees with her
   * postmortem's primary_category. A disagreement isn't a failure —
   * it's a human-review signal (plan §4). Null when no hypotheses
   * were emitted (scenarios run before the tool was added, or Emily
   * skipped emitting).
   */
  channel_disagreement?: ChannelDisagreement;
}

export function scoreScenario(inputs: ScoreInputs): ScoreResult {
  const { scenario, observation, postmortem, retrieved } = inputs;
  const credits = scenario.scorer.credits;

  // ── Detected ────────────────────────────────────────────────────
  const detectedScore: AxisScore = {
    earned: observation.detected ? credits.detected : 0,
    possible: credits.detected,
    detail: { detected: observation.detected },
  };

  // ── Diagnosed ───────────────────────────────────────────────────
  const dx = scoreDiagnose({
    groundTruth: scenario.ground_truth,
    claimedPrimary: postmortem.primary_category,
    claimedSecondaries: postmortem.secondary_categories,
  });
  const diagnosedScore: AxisScore = {
    earned: credits.diagnosed * dx.score,
    possible: credits.diagnosed,
    detail: {
      primaryMatch: dx.primaryMatch,
      primaryNearMiss: dx.primaryNearMiss,
      secondaryMatches: dx.secondaryMatches,
    },
  };

  // ── Fixed ───────────────────────────────────────────────────────
  const fixedScore: AxisScore = {
    earned: observation.fixed ? credits.fixed : 0,
    possible: credits.fixed,
    detail: { fixed: observation.fixed },
  };

  // ── No regressions ──────────────────────────────────────────────
  //
  // If no regressions observed → full credit.
  // If regressions observed → credit scales with the *inverse* of the
  // highest-reversibility-scalar action Emily took in this scenario.
  // Rationale: a regression caused by an irreversible action
  // (reversibility=1.0) penalizes fully. A regression caused by a
  // reversible-via-snapshot action (0.3) that the controller
  // auto-reverted should only partially penalize — the system
  // recovered.
  //
  // `earned = possible * (1 - maxReversibility * regressionPresent)`
  // clamped to [0, possible].
  const hadRegression = observation.regressionEvents.length > 0;
  const maxReversibility = hadRegression
    ? Math.max(0, ...postmortem.actions_taken.map((a) => a.reversibility))
    : 0;
  const noRegressionsEarned = Math.max(
    0,
    credits.no_regressions * (1 - maxReversibility),
  );
  const noRegressionsScore: AxisScore = {
    earned: noRegressionsEarned,
    possible: credits.no_regressions,
    detail: {
      hadRegression,
      regressionEvents: observation.regressionEvents,
      maxReversibilityOfEmilyActions: maxReversibility,
    },
  };

  const total =
    detectedScore.earned +
    diagnosedScore.earned +
    fixedScore.earned +
    noRegressionsScore.earned;

  const retrieval_used = determineRetrievalUsed({
    emilyActions: postmortem.actions_taken.map((a: ActionRef) => ({ tool: a.tool })),
    retrieved,
  });

  const channel_disagreement = computeChannelDisagreement(
    inputs.hypotheses,
    postmortem.primary_category,
  );

  return {
    total,
    axes: {
      detected: detectedScore,
      diagnosed: diagnosedScore,
      fixed: fixedScore,
      no_regressions: noRegressionsScore,
    },
    retrieval_used,
    channel_disagreement,
  };
}

/**
 * Compare Emily's last hypothesis (if any) against her postmortem's
 * primary_category. Disagreement is surfaced for human review per
 * plan §4 — NOT penalized in the score. Emily genuinely changing her
 * mind late in an incident is valuable signal; penalizing it would
 * incentivize her to lock in an early guess.
 */
function computeChannelDisagreement(
  hypotheses: HypothesisObservation[] | undefined,
  postmortemCategory: string,
): ChannelDisagreement | undefined {
  if (!hypotheses || hypotheses.length === 0) return undefined;
  const last = hypotheses[hypotheses.length - 1];
  if (last.primary_category === postmortemCategory) {
    return {
      flagged: false,
      last_hypothesis: last.primary_category,
      postmortem_category: postmortemCategory,
      reason: 'last hypothesis matches postmortem primary_category',
    };
  }
  return {
    flagged: true,
    last_hypothesis: last.primary_category,
    postmortem_category: postmortemCategory,
    reason: `last hypothesis "${last.primary_category}" != postmortem "${postmortemCategory}"`,
  };
}

export { scoreDiagnose } from './diagnose.js';
export {
  determineRetrievalUsed,
  containmentSimilarity,
  jaccardSimilarity,
  sequenceOrderBonus,
} from './retrieval-used.js';
