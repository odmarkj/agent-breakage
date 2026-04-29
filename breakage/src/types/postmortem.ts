import type { Outcome } from './outcome.js';
import type { Reversibility } from './reversibility.js';

/**
 * Postmortem schema. See plan §11.
 *
 * Written by Emily at incident resolution. Human-readable at 3am AND
 * machine-parseable by the scorer. Same schema for scenarios and
 * real production incidents — this is the canonical record.
 *
 * Two field ownership rules matter:
 *
 *   - `retrieval_used` is OBSERVED, not ATTESTED. Emily does not
 *     populate this field. The scorer derives it by comparing her
 *     action sequence to each retrieved postmortem's `actions_taken`.
 *     Retrievals whose action patterns match beyond threshold are
 *     counted "used" regardless of Emily's self-report. Prevents
 *     hallucination on the instrumentation channel.
 *
 *   - `outcome` is set by the framework post-detector-evaluation,
 *     not claimed by Emily. In production, outcome is derived from
 *     SLO recovery + human review. Emily can add context via
 *     `side_effects_observed` but not overwrite the outcome.
 */
export interface Postmortem {
  scenario_id: string | null;   // null for production incidents
  incident_id: string;           // framework-assigned UUID
  detected_at: string;           // ISO-8601
  final_diagnosis: string;
  primary_category: string;
  secondary_categories: string[];
  /** 0-1 self-reported confidence in the diagnosis. */
  confidence: number;
  actions_taken: ActionRef[];
  fix_applied: string;
  /** Hypotheses pursued that turned out wrong. High-signal training data. */
  what_did_not_work: string[];
  time_to_diagnose_s: number;
  time_to_fix_s: number;
  side_effects_observed: string[];
  /**
   * IDs of past postmortems the experience base returned to Emily
   * pre-action. Populated by the framework at retrieval time.
   */
  retrieval_consulted: string[];
  /**
   * IDs the scorer determined Emily actually leveraged, via
   * action-pattern matching against the retrieved postmortems'
   * `actions_taken`. Emily does NOT self-report this.
   */
  retrieval_used: string[];
  outcome: Outcome;
}

export interface ActionRef {
  /** The tool that was invoked. */
  tool: string;
  /** Tool's declared reversibility at invocation time. */
  reversibility: Reversibility;
  /** Redacted tool input summary for the postmortem (not the full payload). */
  input_summary: string;
  /** ISO-8601. */
  at: string;
  /** Whether this action triggered a revert from the speculative-exec controller. */
  reverted: boolean;
  /**
   * If reverted: the mechanical reason from the controller (the
   * metric-level observation that triggered revert). Semantic
   * analysis of the reason belongs in `what_did_not_work`, not here.
   */
  revert_reason_mechanical?: string;
}
