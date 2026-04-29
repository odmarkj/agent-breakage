/**
 * Active-scenario state. Tracks the scenario currently being executed
 * by the runner so /capture-postmortem can associate an inbound
 * postmortem with the right scenario without Emily having to know
 * the scenario_id up front.
 *
 * Single-active-scenario model for Phase 1 — the runner runs
 * scenarios sequentially, not concurrently. Multi-concurrent would
 * require either an explicit scenario_id in the capture request or
 * an event-stream correlation layer; defer to Phase 2+.
 *
 * Capture flow:
 *   1. Orchestrator calls setActive(scenario_id, deadline) before injection
 *   2. Operator's write_postmortem POSTs to /capture-postmortem
 *   3. Runner calls captureAndResolve(postmortem) which wakes any awaiter
 *   4. Orchestrator's awaitCapture() resolves with the captured postmortem
 *      or null on timeout
 *   5. Orchestrator calls clearActive() when the scenario finishes
 */

import type { Postmortem } from '../types/index.js';

/**
 * A hypothesis Emily emitted during the active scenario via her
 * `emit_hypothesis` tool. The runner accumulates them in order so
 * the scorer can observe the reasoning trajectory and compare her
 * last hypothesis to her postmortem's primary_category. See plan §4
 * (hybrid instrumentation) and §11 (disagreement corpus).
 */
export interface CapturedHypothesis {
  primary_category: string;
  secondary_categories: string[];
  confidence: number;
  reasoning: string;
  emitted_at: string;
}

interface ActiveSlot {
  scenario_id: string;
  deadlineMs: number;
  /** Resolves with the captured postmortem when it arrives, or null on timeout. */
  resolver: (p: Postmortem | null) => void;
  promise: Promise<Postmortem | null>;
  captured: boolean;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  /** Hypotheses emitted during this scenario, in emission order. */
  hypotheses: CapturedHypothesis[];
}

let active: ActiveSlot | null = null;

export function hasActive(): boolean {
  return active !== null;
}

export function activeScenarioId(): string | null {
  return active?.scenario_id ?? null;
}

export interface AwaitableCapture {
  awaitCapture: () => Promise<Postmortem | null>;
  clear: () => void;
}

/**
 * Register a scenario as active. Any subsequent /capture-postmortem
 * call will be associated with this scenario (until cleared).
 * Returns an awaiter that the orchestrator uses to block on the
 * postmortem's arrival or timeout.
 */
export function setActive(scenario_id: string, timeoutMs: number): AwaitableCapture {
  if (active !== null) {
    throw new Error(
      `active-scenario: cannot set ${scenario_id} — scenario ${active.scenario_id} is already active. ` +
        `Phase 1 only supports sequential scenario execution.`,
    );
  }

  let resolver!: (p: Postmortem | null) => void;
  const promise = new Promise<Postmortem | null>((resolve) => {
    resolver = resolve;
  });

  const deadlineMs = Date.now() + timeoutMs;
  const timeoutHandle = setTimeout(() => {
    if (active && !active.captured) {
      active.resolver(null);
    }
  }, timeoutMs);

  active = {
    scenario_id,
    deadlineMs,
    resolver,
    promise,
    captured: false,
    timeoutHandle,
    hypotheses: [],
  };

  return {
    awaitCapture: () => promise,
    clear: () => clearActive(scenario_id),
  };
}

/**
 * Receive a postmortem from an /capture-postmortem call. Returns
 * the scenario_id the postmortem was associated with, or null if
 * no scenario is active.
 */
export function captureAndResolve(postmortem: Postmortem): string | null {
  if (!active) return null;
  if (active.captured) return active.scenario_id; // ignore duplicate captures
  active.captured = true;
  if (active.timeoutHandle) clearTimeout(active.timeoutHandle);
  active.resolver(postmortem);
  return active.scenario_id;
}

/**
 * Record a hypothesis emitted by Emily during the active scenario.
 * Returns the scenario_id the hypothesis is associated with, or null
 * if no scenario is active (hypothesis arrived outside the run
 * window — common when Emily emits right at/after the time budget).
 */
export function recordHypothesis(h: CapturedHypothesis): string | null {
  if (!active) return null;
  active.hypotheses.push(h);
  return active.scenario_id;
}

/**
 * Snapshot the hypotheses emitted so far for the active scenario.
 * Returned as a copy so callers can't mutate the internal state.
 */
export function getActiveHypotheses(): CapturedHypothesis[] {
  return active ? [...active.hypotheses] : [];
}

/**
 * Clear the active scenario. Safe to call after the orchestrator
 * has taken (or given up on) the captured postmortem. Idempotent
 * on scenario_id mismatch (no-op if `scenario_id` isn't the
 * currently-active one — protects against race-condition clears
 * during rapid re-runs).
 */
export function clearActive(scenario_id: string): void {
  if (!active || active.scenario_id !== scenario_id) return;
  if (active.timeoutHandle) clearTimeout(active.timeoutHandle);
  // If cleared before capture, signal timeout.
  if (!active.captured) active.resolver(null);
  active = null;
}

/**
 * For tests + /health payload.
 */
export function activeSnapshot(): {
  active: boolean;
  scenario_id: string | null;
  deadline_ms_remaining: number | null;
  captured: boolean;
} {
  if (!active) {
    return { active: false, scenario_id: null, deadline_ms_remaining: null, captured: false };
  }
  return {
    active: true,
    scenario_id: active.scenario_id,
    deadline_ms_remaining: Math.max(0, active.deadlineMs - Date.now()),
    captured: active.captured,
  };
}
