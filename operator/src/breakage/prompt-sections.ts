/**
 * Shared system-prompt sections for Emily's two agent entry points:
 *
 *   1. agent.ts `buildSystemPrompt` — drives /chat (human-initiated)
 *   2. goals/executor.ts `buildGoalSystemPrompt` — drives autonomous
 *      watcher-triggered goal execution (the real production path)
 *
 * Without shared rendering, the Phase-1 improvements (retrieval +
 * playbook + vocab + synthetic-approval operational note) would
 * only apply to the /chat path — which is the secondary way Emily
 * runs in production. The autonomous path, which handles ALL real
 * incidents triaged from Kubernetes events, would be missing them
 * entirely.
 *
 * This module is the single source of truth for those sections.
 */

import { isBreakageEnabled, retrievePast, type RetrievalHit } from './client.js';
import { matchPlaybook, renderPlaybook } from './playbooks.js';
import { renderVocabSection } from './vocab.js';
import { isSyntheticApprovalEnabled } from './synthetic-approval.js';

export interface BreakageSectionsInput {
  /**
   * The text used to query the experience base. For /chat this is
   * the user's message; for the autonomous path this is typically
   * the goal's title + context (what the triaged event says).
   */
  query: string;
  /** How many past postmortems to retrieve. Defaults to 3 per plan §10. */
  k?: number;
}

export interface BreakageSectionsOutput {
  /** Joined markdown — append to the system prompt. Empty string if nothing to add. */
  text: string;
  /** Retrieval hits surfaced to Emily (for logging + observability). */
  retrievalHits: RetrievalHit[];
  /** Whether a playbook matched the top hit. */
  playbookMatched: boolean;
}

/**
 * Build the shared breakage sections for Emily's system prompt.
 * Order:
 *   1. Operational environment (tier-3 approval regime)
 *   2. Root-cause vocabulary
 *   3. Retrieved past incidents (outcome-labeled)
 *   4. Matched playbook (if any)
 *
 * All sections are optional — the function returns empty strings
 * for any that aren't applicable (e.g., vocab unavailable, no
 * playbook match). Callers push the non-empty result onto their
 * parts array.
 */
export async function buildBreakageSections(
  input: BreakageSectionsInput,
): Promise<BreakageSectionsOutput> {
  const parts: string[] = [];

  if (isSyntheticApprovalEnabled()) {
    parts.push(renderSyntheticApprovalSection());
  }

  parts.push(renderHypothesisSection());

  const vocabSection = await renderVocabSection();
  if (vocabSection) parts.push(vocabSection);

  let retrievalHits: RetrievalHit[] = [];
  let playbookMatched = false;

  if (isBreakageEnabled()) {
    retrievalHits = await retrievePast({
      text: input.query,
      k: input.k ?? 3,
      sources: ['incident-log', 'production'],
    });
    const renderedRetrieval = renderRetrievalSection(retrievalHits);
    if (renderedRetrieval) parts.push(renderedRetrieval);

    const match = await matchPlaybook(
      retrievalHits.map((h) => ({
        id: h.id,
        primary_category: h.primary_category,
        distance: h.distance,
      })),
    );
    if (match) {
      parts.push(renderPlaybook(match));
      playbookMatched = true;
    }
  }

  return {
    text: parts.join('\n'),
    retrievalHits,
    playbookMatched,
  };
}

// ── Section renderers ──────────────────────────────────────────────

function renderHypothesisSection(): string {
  return [
    '## Hypothesis emission during investigation',
    '',
    'Use the `emit_hypothesis` tool to surface your current best theory as you investigate. This is separate from `write_postmortem` (end-of-incident, final record) — `emit_hypothesis` captures your evolving diagnosis *during* the incident so the framework can observe where your thinking changed.',
    '',
    'When to emit:',
    '- **After your first pass of investigation tools** (usually 3-5 read calls): pick the closest vocabulary category and a low confidence — this anchors the trajectory.',
    '- **Whenever new evidence would shift your category**: new pod logs, a describe that reveals a missing field, a Secret decode that surprised you. Emit a revised hypothesis with updated confidence and reasoning naming the evidence.',
    '- **Before committing to a fix**: one emission with the hypothesis you are about to act on, so your action sequence is explicitly tied to a stated theory.',
    '',
    'An emission is cheap — prefer several confident-ish emissions over one late high-confidence one. Low confidence on early hypotheses is honest; overconfidence gets flagged when the final diagnosis differs.',
    '',
    'The framework does NOT score `emit_hypothesis` content against the vocabulary directly. It uses your emissions to reconstruct your reasoning trajectory post-hoc and to flag disagreements between your last hypothesis and your final postmortem — those disagreements become training data, not penalties.',
    '',
  ].join('\n');
}

function renderSyntheticApprovalSection(): string {
  return [
    '## Operational environment',
    '',
    'Tier-3 tools (`kubectl_apply`, `kubectl_delete`, `kubectl_rollout_restart`, `kubectl_rollout_undo`, `helm_upgrade`, `helm_rollback`, `postgres_query`) **ARE available** in this environment. A synthetic approver is wired in to auto-decide within ~1s.',
    '',
    'When you invoke a tier-3 tool:',
    '- The approval request goes to the synthetic approver automatically.',
    '- Most requests are approved; some are denied randomly to test denial-recovery behavior.',
    '- On approval, the tool executes inline and the result comes back in the same tool_result.',
    '- On denial, the tool_result includes `{"status":"denied","reason":...}` — do NOT retry the same action; try a different approach or note the gap in your postmortem.',
    '',
    '**Use tier-3 tools when you need them.** Do not artificially avoid them — the approval flow works.',
    '',
  ].join('\n');
}

export function renderRetrievalSection(hits: RetrievalHit[]): string {
  if (hits.length === 0) return '';
  const lines: string[] = [
    '## Similar past incidents',
    '',
    'The following past incidents are semantically similar to what you are investigating. Use them as **context**, not directives:',
    '- **resolved** = what worked. Consider repeating this approach if symptoms match.',
    '- **regressed** = what was tried and made things worse. AVOID repeating these paths.',
    '',
  ];
  for (const h of hits) {
    const outcomeLabel = h.outcome === 'regressed'
      ? '⚠ REGRESSED (counterexample)'
      : h.outcome === 'resolved'
      ? '✓ resolved'
      : '~ inconclusive';
    lines.push(`### ${h.id} — ${outcomeLabel} — category: \`${h.primary_category}\``);
    lines.push('');
    lines.push(`**Diagnosis:** ${h.final_diagnosis.split('\n').join(' ').slice(0, 500)}`);
    lines.push('');
    lines.push(`**Fix applied:** ${h.fix_applied.split('\n').join(' ').slice(0, 300)}`);
    if (h.what_did_not_work.length > 0) {
      lines.push('');
      lines.push('**Dead ends to avoid:**');
      for (const d of h.what_did_not_work) {
        lines.push(`- ${d}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
