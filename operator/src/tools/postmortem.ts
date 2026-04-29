import type { ToolDefinition } from '../types.js';
import { isBreakageEnabled, reportPostmortem, type EmilyPostmortem } from '../breakage/index.js';

/**
 * write_postmortem — Emily's structured end-of-incident record.
 *
 * Tier 1, reversibility 0.0: a read/emit tool that produces
 * human-readable AND machine-parseable YAML. Same schema for
 * scenario runs and production incidents (the scenario_id
 * context-token mapping lives at the event-intake layer, not here).
 *
 * Emily populates the diagnostic fields; the breakage framework
 * populates:
 *   - retrieval_used (observed by action-pattern matching, NOT
 *     self-reported — Emily must leave this empty)
 *   - outcome (set by the framework after detector evaluation
 *     or by human review for real incidents)
 *   - incident_id (assigned by the framework)
 *
 * In production (outside a scenario), the tool persists directly to
 * the experience base; in scenarios, the runner captures the YAML
 * for scoring. Either way Emily's interface is identical.
 */
export const writePostmortem: ToolDefinition = {
  name: 'write_postmortem',
  description:
    'Write a structured postmortem at the resolution of an incident. Produces human-readable YAML for ops teams AND structured input for the experience base. Use when you believe an incident is fixed OR when escalating to humans after exhausting your diagnosis. ' +
    'Populate your diagnostic fields (final_diagnosis, primary_category from breakage/vocab/root-cause-categories.yaml, optional secondary_categories, confidence, actions_taken, fix_applied, what_did_not_work, time_to_diagnose_s, time_to_fix_s, side_effects_observed). ' +
    'Do NOT populate retrieval_used or outcome — the framework observes those. Do NOT populate incident_id — the framework assigns it.',
  tier: 1,
  reversibility: 0.0,
  adminOnly: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      final_diagnosis: {
        type: 'string',
        description: 'Single-paragraph description of what was actually wrong, written so a human ops engineer can understand at 3am.',
      },
      primary_category: {
        type: 'string',
        description:
          'The single most important category from breakage/vocab/root-cause-categories.yaml. If no existing category fits, propose a new one with rationale (will be human-reviewed).',
      },
      secondary_categories: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Additional co-occurring categories for compound-cause incidents. Empty array for single-cause. Each entry must be a vocabulary category.',
      },
      confidence: {
        type: 'number',
        description: '0-1 self-reported confidence in the diagnosis.',
      },
      actions_taken: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string' },
            input_summary: { type: 'string' },
            at: { type: 'string' },
            reverted: { type: 'boolean' },
            revert_reason_mechanical: { type: 'string' },
          },
          required: ['tool', 'input_summary', 'at', 'reverted'],
        },
        description:
          'Ordered list of tool invocations. The framework appends reversibility automatically from each tool\'s registered metadata.',
      },
      fix_applied: {
        type: 'string',
        description: 'The specific change that resolved the incident. If there was no fix (escalation), describe what was left for humans.',
      },
      what_did_not_work: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Hypotheses you pursued that turned out wrong. High-signal training data. DO report dead ends even if they feel embarrassing — the framework cross-checks against your tool-call history anyway.',
      },
      time_to_diagnose_s: {
        type: 'number',
        description: 'Seconds from incident detection to final diagnosis.',
      },
      time_to_fix_s: {
        type: 'number',
        description: 'Seconds from incident detection to fix applied (or escalation).',
      },
      side_effects_observed: {
        type: 'array',
        items: { type: 'string' },
        description: 'Any downstream impact you observed (other services affected, secrets disturbed, etc.).',
      },
    },
    required: [
      'final_diagnosis',
      'primary_category',
      'secondary_categories',
      'confidence',
      'actions_taken',
      'fix_applied',
      'what_did_not_work',
      'time_to_diagnose_s',
      'time_to_fix_s',
      'side_effects_observed',
    ],
  },
  async execute(input) {
    // Coerce Emily's input with defensive validation. The fields
    // come back from her JSON output and she sometimes passes
    // placeholder strings like "N/A" for numeric fields, which
    // break DB persistence downstream. Coerce to 0 when not a
    // valid finite number.
    const toInt = (v: unknown): number => {
      if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v));
      if (typeof v === 'string') {
        const n = Number(v);
        if (Number.isFinite(n)) return Math.max(0, Math.round(n));
      }
      return 0;
    };
    const toNumber = (v: unknown, defaultValue: number): number => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
      return defaultValue;
    };
    const toStringArray = (v: unknown): string[] => {
      if (!Array.isArray(v)) return [];
      return v.filter((x): x is string => typeof x === 'string');
    };

    const payload: EmilyPostmortem = {
      final_diagnosis: String(input.final_diagnosis ?? '').trim(),
      primary_category: String(input.primary_category ?? '').trim(),
      secondary_categories: toStringArray(input.secondary_categories),
      confidence: Math.max(0, Math.min(1, toNumber(input.confidence, 0.5))),
      actions_taken: Array.isArray(input.actions_taken)
        ? (input.actions_taken as EmilyPostmortem['actions_taken'])
        : [],
      fix_applied: String(input.fix_applied ?? ''),
      what_did_not_work: toStringArray(input.what_did_not_work),
      time_to_diagnose_s: toInt(input.time_to_diagnose_s),
      time_to_fix_s: toInt(input.time_to_fix_s),
      side_effects_observed: toStringArray(input.side_effects_observed),
      detected_at: new Date().toISOString(),
    };

    // Early validation before hitting the network. If Emily passes
    // an empty primary_category or final_diagnosis (often because
    // she's uncertain which vocab term fits), return an error-shaped
    // result FIRST so the error is the first thing her next turn's
    // model sees — not buried after a long payload. Previously the
    // runner's 400 came back in a `note` field after the payload,
    // and Emily kept re-submitting with the same empty value because
    // she was reading her own payload instead of the error note.
    const preflightMissing: string[] = [];
    if (!payload.primary_category) preflightMissing.push('primary_category');
    if (!payload.final_diagnosis) preflightMissing.push('final_diagnosis');
    if (preflightMissing.length > 0) {
      return {
        error: `write_postmortem rejected: required field(s) were empty: ${preflightMissing.join(', ')}. These fields cannot be blank strings. For primary_category, pick the single best-fitting id from the vocabulary rendered in your system prompt (even if imperfect — picking the closest term scores partial credit; leaving it blank scores zero). Then call write_postmortem again with the field populated.`,
        kind: 'postmortem-rejected',
        missing_fields: preflightMissing,
      };
    }

    // Report to the breakage runner if configured. No-op in
    // environments where BREAKAGE_RUNNER_URL isn't set (dev/prod
    // outside scenarios).
    //
    // Emily needs to see rejection reasons inline so she can retry
    // with missing fields (400) instead of assuming success. A flat
    // boolean hid 400/409 errors from her and made the write_postmortem
    // tool look silent-failing.
    const reportResult = isBreakageEnabled()
      ? await reportPostmortem(payload)
      : ({ captured: false, reason: 'unconfigured' } as const);

    const note = noteFor(reportResult, payload);

    // If the runner rejected it, front-load the error so it's the
    // first thing Emily's next turn reads.
    if (!reportResult.captured && reportResult.reason === 'rejected') {
      return {
        error: note,
        kind: 'postmortem-rejected',
        reported_to_breakage_runner: false,
        payload,
      };
    }

    return {
      kind: 'postmortem-draft',
      payload,
      reported_to_breakage_runner: reportResult.captured,
      note,
    };
  },
};

function noteFor(
  r: Awaited<ReturnType<typeof reportPostmortem>>,
  p: EmilyPostmortem,
): string {
  if (r.captured) {
    return 'Captured by breakage runner; framework-owned fields (retrieval_used, outcome, incident_id) will be populated there.';
  }
  if (r.reason === 'unconfigured') {
    return 'Breakage runner unconfigured (no BREAKAGE_RUNNER_URL). Postmortem shape is valid for human review; not associated with a scenario run.';
  }
  if (r.reason === 'unreachable') {
    return `Breakage runner unreachable (${r.error}). Postmortem shape is valid for human review but was not captured. If this is a scenario run, the scorer will fall back to the scenario-timeout stub.`;
  }
  // rejected
  if (r.status === 400) {
    const missing = missingRequiredFields(p);
    const missingList = missing.length > 0 ? missing.join(', ') : 'unknown required field(s)';
    return `Runner rejected the postmortem (HTTP 400: ${missingList} missing or empty). Call write_postmortem again with those fields populated — this tool result is NOT a success. ${truncateError(r.error)}`;
  }
  if (r.status === 409) {
    return `Runner rejected the postmortem (HTTP 409: no active scenario — the scenario's time budget likely elapsed before this postmortem arrived). Retrying will not help. Finish up and document the timeout in your next response. ${truncateError(r.error)}`;
  }
  return `Runner rejected the postmortem (HTTP ${r.status}). ${truncateError(r.error)}`;
}

function missingRequiredFields(p: EmilyPostmortem): string[] {
  const missing: string[] = [];
  if (!p.final_diagnosis || p.final_diagnosis.trim() === '') missing.push('final_diagnosis');
  if (!p.primary_category || p.primary_category.trim() === '') missing.push('primary_category');
  return missing;
}

function truncateError(err: string): string {
  const s = err.trim();
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}
