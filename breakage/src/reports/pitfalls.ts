/**
 * Inverse-guardrail-mining — the Week-4 cut from plan §16.
 *
 * This is NOT a new system. It's a query pattern over the
 * postmortems table, filtered by outcome='regressed' and grouped by
 * primary_category + action_pattern. Output is a per-category
 * `pitfalls-draft.md` report that humans review before any entries
 * are propagated into playbooks or Emily's context.
 *
 * The purpose of the Week-4 cut is two-fold (per plan §16):
 *   (a) surface real pitfalls in Emily's behavior early
 *   (b) validate the mining pipeline on synthetic baseline data
 *       BEFORE it's ever run against real production incidents
 *
 * Reports are human-reviewed. Nothing in here feeds Emily directly.
 * Automated injection into Emily's context is Phase 5+ (explicitly
 * deferred per plan §"Out of Phase 1").
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { closeSql, getSql } from '../lib/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPORTS_ROOT = resolve(__dirname, '../../reports/pitfalls');

// Minimum co-occurrence before a pattern is worth reporting.
// Below this, it's more likely to be noise than a real pitfall.
const MIN_OCCURRENCES = 2;

// Secondary-lens cutoff. Scenario postmortems scoring below this
// count as "Emily struggled" even when outcome!='regressed'.
const LOW_SCORE_THRESHOLD = 0.5;

// ── Data shapes ─────────────────────────────────────────────────────

interface RegressedRow {
  id: string;
  primary_category: string;
  actions_taken: Array<{ tool: string; input_summary: string; reversibility: number }>;
  final_diagnosis: string;
  what_did_not_work: string[];
  fix_applied: string;
  source: string;
}

interface PatternCount {
  pattern: string;  // e.g. "kubectl_get → kubectl_apply → postgres_query"
  count: number;
  /** Example incident IDs that matched this pattern. */
  examples: string[];
}

interface CategoryReport {
  category: string;
  totalRegressed: number;
  patterns: PatternCount[];
  /** All what_did_not_work entries across regressed incidents in this category. */
  commonDeadEnds: string[];
  /** Example final_diagnosis strings — useful for human reviewers. */
  sampleDiagnoses: string[];
}

// ── Mining ──────────────────────────────────────────────────────────

/**
 * Pull all regressed postmortems, group by primary_category, compute
 * per-category action-sequence patterns that precede regressions,
 * and write one markdown report per category.
 */
export async function minePitfalls(): Promise<{
  categoriesReported: number;
  totalRegressedPostmortems: number;
}> {
  const rows = await fetchRegressed();
  if (rows.length === 0) {
    console.log('[pitfalls] no regressed postmortems in corpus — nothing to mine');
    return { categoriesReported: 0, totalRegressedPostmortems: 0 };
  }

  const byCategory = new Map<string, RegressedRow[]>();
  for (const r of rows) {
    if (!byCategory.has(r.primary_category)) byCategory.set(r.primary_category, []);
    byCategory.get(r.primary_category)!.push(r);
  }

  await mkdir(REPORTS_ROOT, { recursive: true });

  let categoriesReported = 0;
  for (const [category, incidents] of byCategory) {
    const report = summarizeCategory(category, incidents);
    if (report.patterns.length === 0 && report.commonDeadEnds.length === 0) {
      // Nothing meaningful surfaced — skip.
      continue;
    }
    const md = renderReport(report);
    const outPath = resolve(REPORTS_ROOT, `${category}.md`);
    await writeFile(outPath, md, 'utf8');
    console.log(`[pitfalls] ${category}: ${incidents.length} regressed, ${report.patterns.length} patterns → ${outPath}`);
    categoriesReported += 1;
  }

  // Also write a top-level index.
  const indexMd = renderIndex(byCategory);
  await writeFile(resolve(REPORTS_ROOT, 'INDEX.md'), indexMd, 'utf8');

  return {
    categoriesReported,
    totalRegressedPostmortems: rows.length,
  };
}

async function fetchRegressed(): Promise<RegressedRow[]> {
  const sql = getSql();
  // Two data sources:
  //   (a) outcome='regressed' — the canonical signal per plan §16.
  //   (b) source='scenario' AND score < LOW_SCORE_THRESHOLD — a
  //       secondary lens that surfaces scenarios where Emily
  //       struggled even when detectors didn't trip a regression.
  //       This is pragmatic signal-amplification at a phase where
  //       most scenarios have empty regressed_when detectors, so
  //       outcome='regressed' undercounts real Emily-failed runs.
  //       Plan §16 doesn't prohibit this; the miner is "a query
  //       pattern" and we adapt it to the data we have.
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT id, primary_category, actions_taken, final_diagnosis,
           what_did_not_work, fix_applied, source, outcome,
           (run_metadata->'score'->>'total')::float AS score
      FROM postmortems
     WHERE primary_category != 'framework-error'
       AND (
         outcome = 'regressed'
         OR (source = 'scenario' AND (run_metadata->'score'->>'total')::float < ${LOW_SCORE_THRESHOLD})
       )
  `;
  return rows.map((r) => ({
    id: r.id as string,
    primary_category: r.primary_category as string,
    actions_taken: (r.actions_taken as RegressedRow['actions_taken']) ?? [],
    final_diagnosis: (r.final_diagnosis as string) ?? '',
    what_did_not_work: (r.what_did_not_work as string[]) ?? [],
    fix_applied: (r.fix_applied as string) ?? '',
    source: r.source as string,
  }));
}

function summarizeCategory(category: string, incidents: RegressedRow[]): CategoryReport {
  // Action-sequence pattern: order-sensitive sequence of tool names.
  // This is the strict pattern — matches Emily running the exact
  // same trajectory. Useful when it catches something; misses on
  // agent-reasoning variance.
  //
  // Coarser pattern: sorted unique tool-set. Catches "Emily used
  // this mix of tools" regardless of order or repetition. When
  // exact-sequence misses, the tool-set pattern often still
  // surfaces signal.
  const patternCounts = new Map<string, { count: number; examples: string[] }>();
  for (const inc of incidents) {
    const tools = inc.actions_taken.map((a) => a.tool);
    const sequence = tools.join(' → ');
    if (sequence) {
      const e = patternCounts.get(sequence) ?? { count: 0, examples: [] };
      e.count += 1;
      if (e.examples.length < 3) e.examples.push(inc.id);
      patternCounts.set(sequence, e);
    }
    const toolSet = Array.from(new Set(tools)).sort().join(' + ');
    if (toolSet && toolSet !== sequence) {
      // Distinguish tool-set entries so we don't double-count exact
      // matches (where sorted-set == sequence after de-dup).
      const key = `SET: ${toolSet}`;
      const e = patternCounts.get(key) ?? { count: 0, examples: [] };
      e.count += 1;
      if (e.examples.length < 3) e.examples.push(inc.id);
      patternCounts.set(key, e);
    }
  }

  const patterns: PatternCount[] = Array.from(patternCounts.entries())
    .filter(([, v]) => v.count >= MIN_OCCURRENCES)
    .map(([pattern, v]) => ({ pattern, count: v.count, examples: v.examples }))
    .sort((a, b) => b.count - a.count);

  const deadEndCounts = new Map<string, number>();
  for (const inc of incidents) {
    for (const d of inc.what_did_not_work) {
      deadEndCounts.set(d, (deadEndCounts.get(d) ?? 0) + 1);
    }
  }
  const commonDeadEnds = Array.from(deadEndCounts.entries())
    .filter(([, c]) => c >= 1) // dead-end text is verbose; one occurrence is already informative
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([text]) => text);

  const sampleDiagnoses = incidents.slice(0, 5).map((i) => i.final_diagnosis);

  return {
    category,
    totalRegressed: incidents.length,
    patterns,
    commonDeadEnds,
    sampleDiagnoses,
  };
}

// ── Rendering ───────────────────────────────────────────────────────

function renderReport(report: CategoryReport): string {
  const lines: string[] = [
    `# Pitfalls draft — ${report.category}`,
    '',
    `**Generated:** ${new Date().toISOString()}`,
    `**Corpus:** ${report.totalRegressed} regressed postmortem(s) with primary_category=\`${report.category}\``,
    '',
    '> Auto-generated from the experience base by `npm run pitfalls`. This is a',
    '> **DRAFT for human review**, not a directive. Do not feed the entries below',
    '> into Emily\'s context without reviewing each one against the underlying',
    '> incidents. Phase-1 §16 explicitly defers automated injection of this',
    '> output into Emily\'s reasoning until Phase 5+.',
    '',
    '---',
    '',
    '## Action-sequence patterns that preceded regressions',
    '',
  ];

  if (report.patterns.length === 0) {
    lines.push(`_No repeated action-sequence patterns met the min-occurrences threshold (${MIN_OCCURRENCES})._`);
    lines.push('');
  } else {
    lines.push('Emily\'s actions in order of how often the sequence preceded a regressed outcome.');
    lines.push('Higher-count patterns are higher-priority review targets.');
    lines.push('');
    lines.push('| Count | Action sequence | Example incidents |');
    lines.push('|-------|-----------------|-------------------|');
    for (const p of report.patterns) {
      const exs = p.examples.map((e) => `\`${e}\``).join(', ');
      lines.push(`| ${p.count} | \`${p.pattern}\` | ${exs} |`);
    }
    lines.push('');
  }

  lines.push('## Dead-ends Emily self-reported');
  lines.push('');
  if (report.commonDeadEnds.length === 0) {
    lines.push('_No `what_did_not_work` entries in the regressed postmortems._');
  } else {
    for (const d of report.commonDeadEnds) {
      lines.push(`- ${d}`);
    }
  }
  lines.push('');

  lines.push('## Sample diagnoses from regressed postmortems');
  lines.push('');
  for (const d of report.sampleDiagnoses) {
    lines.push(`> ${d.split('\n').join(' ').trim()}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## Reviewer checklist');
  lines.push('');
  lines.push('- [ ] Are the top-count patterns genuinely bad behaviors Emily should avoid, or coincidence?');
  lines.push('- [ ] Are there specific fix templates Emily should try FIRST for this category?');
  lines.push('- [ ] Is there context missing from Emily\'s postmortem schema that would have disambiguated these regressions?');
  lines.push('- [ ] If this pattern is real, promote to a `known_pitfalls` entry in `context/playbooks/<category>.yaml` (Week 5+).');

  return lines.join('\n') + '\n';
}

function renderIndex(byCategory: Map<string, RegressedRow[]>): string {
  const lines: string[] = [
    '# Pitfalls reports — index',
    '',
    `**Generated:** ${new Date().toISOString()}`,
    '',
    'Auto-generated summaries of regressed-outcome postmortems grouped by primary_category.',
    'These are **drafts for human review** per plan §16. Nothing here feeds Emily automatically.',
    '',
    '| Category | Regressed count | Report |',
    '|----------|-----------------|--------|',
  ];
  const sorted = Array.from(byCategory.entries()).sort((a, b) => b[1].length - a[1].length);
  for (const [cat, incs] of sorted) {
    lines.push(`| \`${cat}\` | ${incs.length} | [${cat}.md](./${cat}.md) |`);
  }
  lines.push('');
  return lines.join('\n') + '\n';
}

// ── Entry point ─────────────────────────────────────────────────────

const isMain = process.argv[1] === __filename;
if (isMain) {
  minePitfalls()
    .then(async ({ categoriesReported, totalRegressedPostmortems }) => {
      console.log(
        `[pitfalls] done. ${categoriesReported} categories reported, ${totalRegressedPostmortems} regressed postmortems in corpus.`,
      );
      await closeSql();
    })
    .catch(async (err) => {
      console.error('[pitfalls] failed:', err);
      await closeSql();
      process.exit(1);
    });
}
