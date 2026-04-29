/**
 * Detector interface. Evaluates a scenario's `fixed_when` and
 * `regressed_when` conditions against cluster state + metrics.
 *
 * Each condition is a free-form expression the Evaluator parses
 * and dispatches to a Handler (K8s API or Prometheus). Handlers
 * are tried in order; first match wins.
 */

import type { DetectorCondition } from '../types/index.js';

export interface Evaluator {
  /**
   * Evaluate a single condition once. Returns true/false based on
   * current cluster state; the runner layer handles `sustained_for_s`
   * by polling evaluate() at intervals.
   */
  evaluate(expression: string): Promise<boolean>;
}

export interface ExpressionHandler {
  /**
   * Try to match and evaluate. Returns null if this handler
   * doesn't recognize the expression (dispatch continues); returns
   * a boolean if it evaluated; throws on evaluation error.
   */
  tryEvaluate(expression: string): Promise<boolean | null>;
}

/**
 * Wraps an Evaluator with sustained-duration enforcement. Calls
 * evaluate() at the poll interval and returns true only if the
 * condition has held continuously for the required duration.
 */
export interface SustainedEvaluator {
  /**
   * Evaluate a condition with sustained_for_s semantics.
   * Returns true when the condition has held for the required
   * duration, false if it fails at any check, or throws if the
   * time budget expires before the sustained window completes.
   */
  evaluateSustained(
    cond: DetectorCondition,
    opts: { timeoutMs: number; pollIntervalMs?: number },
  ): Promise<boolean>;
}
