/**
 * Playbook loader. Reads structured playbook YAMLs from
 * context/playbooks/ and selects matches for a given incident
 * context.
 *
 * Plan §13, §16, §17: playbooks are hand-written priors, injected
 * into Emily's prompt when retrieval's data-driven priors aren't
 * strong enough yet for a category. Authored in response to
 * scorecard gaps (see reports/pitfalls/*.md) and reviewed by
 * humans before entering Emily's context.
 *
 * Matching heuristic (Phase 1): find the playbook whose
 * `applies_to.root_cause_category` matches the category of the
 * most-similar retrieved past postmortem. Conservative — only one
 * playbook is injected per incident, and only when retrieval has
 * a high-confidence precedent hit.
 *
 * Playbooks live on disk (not fetched from the breakage runner)
 * so they work identically in scenario mode and production.
 */

import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve relative to the compiled module's location so this works
// the same in dev (tsx) and production (esbuild bundle).
const PLAYBOOKS_DIR = resolve(
  process.env.OPERATOR_PLAYBOOKS_DIR
  ?? resolve(__dirname, '../../..', 'context/playbooks'),
);

// ── Types ───────────────────────────────────────────────────────────

export interface Playbook {
  id: string;
  applies_to: {
    root_cause_category: string;
    symptoms?: Array<Record<string, string>>;
  };
  likely_causes_ordered: Array<{ cause: string; prior: number }>;
  diagnostic_steps: string[];
  fix_templates: Array<{ if_cause: string; action: string } | string>;
  known_pitfalls: string[];
}

export interface PlaybookMatch {
  playbook: Playbook;
  matched_on: 'primary_category' | 'secondary_category';
  source_postmortem_id: string;
}

// ── Loading ─────────────────────────────────────────────────────────

let _cached: Map<string, Playbook> | null = null;

async function loadAll(): Promise<Map<string, Playbook>> {
  if (_cached) return _cached;
  const map = new Map<string, Playbook>();
  let entries: string[];
  try {
    entries = await readdir(PLAYBOOKS_DIR);
  } catch {
    // Directory doesn't exist → no playbooks. Not an error; most
    // production operators won't have any until the scorecard
    // surfaces categories that need them.
    _cached = map;
    return map;
  }
  for (const name of entries) {
    if (!(name.endsWith('.yaml') || name.endsWith('.yml'))) continue;
    try {
      const text = await readFile(resolve(PLAYBOOKS_DIR, name), 'utf8');
      const parsed = parseYaml(text) as Playbook | null;
      if (!parsed || !parsed.id || !parsed.applies_to?.root_cause_category) {
        console.warn(`[playbooks] ${name} missing id or applies_to.root_cause_category, skipping`);
        continue;
      }
      map.set(parsed.applies_to.root_cause_category, parsed);
    } catch (err) {
      console.warn(`[playbooks] ${name} parse failed: ${(err as Error).message}`);
    }
  }
  _cached = map;
  return map;
}

/**
 * Given the retrieval hits Emily received, pick the most-relevant
 * playbook — the one whose `applies_to.root_cause_category` matches
 * the category of the closest retrieval hit. Returns null when
 * either no retrieval happened or no playbook covers the
 * retrieved category (which is the common case — playbooks are
 * rare, written only in response to scorecard gaps).
 */
export async function matchPlaybook(
  hits: Array<{ id: string; primary_category: string; distance: number }>,
): Promise<PlaybookMatch | null> {
  if (hits.length === 0) return null;
  const all = await loadAll();
  if (all.size === 0) return null;

  const sorted = [...hits].sort((a, b) => a.distance - b.distance);
  for (const hit of sorted) {
    const pb = all.get(hit.primary_category);
    if (pb) {
      return {
        playbook: pb,
        matched_on: 'primary_category',
        source_postmortem_id: hit.id,
      };
    }
  }
  return null;
}

/**
 * Render a playbook as a system-prompt section. Emily sees it
 * *after* the retrieval section with an explicit instruction
 * that this is a human-authored prior for the category.
 */
export function renderPlaybook(match: PlaybookMatch): string {
  const { playbook: p } = match;
  const lines: string[] = [
    `## Playbook for \`${p.applies_to.root_cause_category}\``,
    '',
    `This is a **human-authored playbook** for the category matched by your nearest retrieval hit (\`${match.source_postmortem_id}\`). It encodes prior knowledge about this failure class that may not be obvious from the retrieval examples alone. Use it as guidance; override when the specifics of the current incident contradict it.`,
    '',
    '### Likely causes (ordered by prior probability)',
    '',
  ];
  for (const c of p.likely_causes_ordered) {
    lines.push(`- **${(c.prior * 100).toFixed(0)}%** — ${c.cause}`);
  }
  lines.push('');

  lines.push('### Diagnostic steps');
  lines.push('');
  for (let i = 0; i < p.diagnostic_steps.length; i++) {
    lines.push(`${i + 1}. ${p.diagnostic_steps[i]}`);
  }
  lines.push('');

  lines.push('### Fix templates');
  lines.push('');
  for (const f of p.fix_templates) {
    if (typeof f === 'string') {
      lines.push(`- ${f}`);
    } else {
      lines.push(`- **if ${f.if_cause}:** ${f.action}`);
    }
  }
  lines.push('');

  if (p.known_pitfalls.length > 0) {
    lines.push('### Known pitfalls (avoid these)');
    lines.push('');
    for (const pitfall of p.known_pitfalls) {
      lines.push(`- ⚠ ${pitfall}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Test hook ───────────────────────────────────────────────────────

export function _clearCache(): void {
  _cached = null;
}
