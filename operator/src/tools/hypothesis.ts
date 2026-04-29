import type { ToolDefinition } from '../types.js';
import { isBreakageEnabled, reportHypothesis } from '../breakage/index.js';

/**
 * emit_hypothesis — mid-investigation working diagnosis.
 *
 * Emily calls this tool during investigation to surface her current
 * best hypothesis about what's wrong. Distinct from write_postmortem
 * (end-of-incident, structured final record). Multiple emissions per
 * incident are expected — Emily revises as evidence accumulates.
 *
 * Purpose (plan §4 — hybrid instrumentation):
 *   - Gives the implicit scorer a structured trajectory, not just the
 *     final postmortem — so we can observe WHERE her diagnosis
 *     changed and compare early hypotheses to late ones.
 *   - The scorer flags runs where her last hypothesis disagrees with
 *     her postmortem's `primary_category`. Disagreement corpus is
 *     training signal for both her future postmortems AND the
 *     channel-inference pipeline.
 *
 * Tier 1, reversibility 0.0. No side effects — the tool just records
 * the emission into the event stream. The framework picks it up from
 * actions_taken post-hoc; no separate persistence layer in Phase 1.
 */
export const emitHypothesis: ToolDefinition = {
  name: 'emit_hypothesis',
  description:
    'Record your current best hypothesis about the incident. Call this after initial investigation, after any evidence that would cause you to revise your thinking, and before committing to a fix. Multiple emissions per incident are expected — the framework captures the full trajectory. ' +
    'Populate primary_category from the vocabulary (same list as write_postmortem); set confidence honestly (0 = pure guess, 1 = certain); write reasoning as 1-2 sentences naming the evidence that got you there. ' +
    'This is NOT a substitute for write_postmortem — it records your working theory mid-investigation. Always call write_postmortem at resolution with your final structured record.',
  tier: 1,
  reversibility: 0.0,
  adminOnly: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      primary_category: {
        type: 'string',
        description:
          'Your current best-guess category from breakage/vocab/root-cause-categories.yaml. Pick the single closest match even if imperfect — empty/null scores zero on the implicit-inference channel.',
      },
      secondary_categories: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Additional co-occurring categories you suspect. Empty array is fine when single-cause.',
      },
      confidence: {
        type: 'number',
        description:
          '0-1 self-reported confidence. Low confidence on an early hypothesis is expected and healthy; overconfidence scored against if the final diagnosis differs.',
      },
      reasoning: {
        type: 'string',
        description:
          '1-2 sentences naming the evidence that led you here. E.g., "Pod logs show OOMKilled on startup; memory limit is 32Mi per kubectl_describe; working set likely higher." Link to specific tool calls by reference where possible.',
      },
    },
    required: ['primary_category', 'confidence', 'reasoning'],
  },
  async execute(input) {
    const primary = String(input.primary_category ?? '').trim();
    const reasoning = String(input.reasoning ?? '').trim();
    const confidence = typeof input.confidence === 'number'
      ? Math.max(0, Math.min(1, input.confidence))
      : 0.5;
    const secondaryRaw = Array.isArray(input.secondary_categories)
      ? input.secondary_categories
      : [];
    const secondary = secondaryRaw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);

    if (!primary) {
      return {
        error: 'emit_hypothesis rejected: primary_category cannot be empty. Pick the closest vocabulary term.',
        kind: 'hypothesis-rejected',
      };
    }
    if (!reasoning) {
      return {
        error: 'emit_hypothesis rejected: reasoning cannot be empty. A one-sentence "because X evidence" is enough.',
        kind: 'hypothesis-rejected',
      };
    }

    const hypothesis = {
      primary_category: primary,
      secondary_categories: secondary,
      confidence,
      reasoning,
      emitted_at: new Date().toISOString(),
    };

    // Forward to the runner so the scorer can observe Emily's
    // trajectory. No-op when BREAKAGE_RUNNER_URL isn't set (prod /
    // dev outside scenarios) — hypotheses only have meaning inside
    // a scenario run.
    const runnerResult = isBreakageEnabled()
      ? await reportHypothesis(hypothesis)
      : ({ recorded: false, reason: 'unconfigured' } as const);

    return {
      kind: 'hypothesis-recorded',
      payload: hypothesis,
      forwarded_to_runner: runnerResult.recorded,
      note: runnerResult.recorded
        ? 'Hypothesis captured by the framework. Continue investigating; emit again if evidence shifts your thinking, and finalize via write_postmortem at resolution.'
        : 'Hypothesis logged locally. Continue investigating; emit again if evidence shifts your thinking, and finalize via write_postmortem at resolution.',
    };
  },
};
