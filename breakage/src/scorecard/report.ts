/**
 * Scorecard report generator.
 *
 * Queries scenario-source postmortems + run_metadata from the
 * experience base and renders a markdown report with:
 *
 *   - Per-scenario pass/fail + mean score across reps
 *   - Per-category rollup (aggregated across scenarios in category)
 *   - Retrieval-impact comparison (scenarios where retrieval was
 *     used vs not — informs whether the experience base is helping)
 *   - Recent-runs trend (last N scorecard batches, if any)
 *
 * Pass threshold: ≥75% (plan §17 launch threshold; adjustable via
 * BREAKAGE_PASS_THRESHOLD env).
 *
 * Run via: npm run scorecard
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSql, getSql } from '../lib/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPORTS_ROOT = resolve(__dirname, '../../reports');
const PASS_THRESHOLD = Number(process.env.BREAKAGE_PASS_THRESHOLD ?? 0.75);

interface ScenarioRow {
  incident_id: string;
  scenario_id: string;
  primary_category: string;
  run_metadata: {
    ran_at: string;
    score: { total: number };
    detector: { fixed: boolean; regressions: string[]; elapsed_ms: number };
    retrieval: { k: number; consulted: string[]; used: string[] };
  };
  outcome: string;
}

interface PerScenarioStats {
  scenario_id: string;
  primary_category: string;
  reps: number;
  mean_score: number;
  min_score: number;
  max_score: number;
  pass_rate: number;
  with_retrieval_used_count: number;
  last_ran_at: string;
}

// ── Query ───────────────────────────────────────────────────────────

async function fetchScenarioRuns(opts: { limitDays?: number } = {}): Promise<ScenarioRow[]> {
  const sql = getSql();
  const since = new Date(Date.now() - (opts.limitDays ?? 30) * 86400_000).toISOString();
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT id, scenario_id, primary_category, run_metadata, outcome
      FROM postmortems
     WHERE source = 'scenario'
       AND run_metadata IS NOT NULL
       AND created_at >= ${since}::timestamptz
  `;
  return rows.map((r) => ({
    incident_id: r.id as string,
    scenario_id: r.scenario_id as string,
    primary_category: r.primary_category as string,
    run_metadata: r.run_metadata as ScenarioRow['run_metadata'],
    outcome: r.outcome as string,
  }));
}

// ── Aggregation ─────────────────────────────────────────────────────

function summarizeByScenario(rows: ScenarioRow[]): PerScenarioStats[] {
  const byScenario = new Map<string, ScenarioRow[]>();
  for (const r of rows) {
    if (!byScenario.has(r.scenario_id)) byScenario.set(r.scenario_id, []);
    byScenario.get(r.scenario_id)!.push(r);
  }

  const stats: PerScenarioStats[] = [];
  for (const [sid, runs] of byScenario) {
    const scores = runs.map((r) => r.run_metadata.score.total);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const passes = scores.filter((s) => s >= PASS_THRESHOLD).length;
    const withRetrievalUsed = runs.filter((r) => (r.run_metadata.retrieval?.used ?? []).length > 0).length;
    const lastRan = runs
      .map((r) => r.run_metadata.ran_at)
      .sort()
      .at(-1)!;

    stats.push({
      scenario_id: sid,
      primary_category: runs[0].primary_category,
      reps: runs.length,
      mean_score: mean,
      min_score: min,
      max_score: max,
      pass_rate: passes / runs.length,
      with_retrieval_used_count: withRetrievalUsed,
      last_ran_at: lastRan,
    });
  }
  return stats.sort((a, b) => a.mean_score - b.mean_score); // worst first
}

function rollupByCategory(stats: PerScenarioStats[]): Array<{
  category: string;
  scenarios: number;
  mean_score: number;
  pass_rate: number;
}> {
  const byCat = new Map<string, PerScenarioStats[]>();
  for (const s of stats) {
    if (!byCat.has(s.primary_category)) byCat.set(s.primary_category, []);
    byCat.get(s.primary_category)!.push(s);
  }
  return Array.from(byCat.entries())
    .map(([category, ss]) => ({
      category,
      scenarios: ss.length,
      mean_score: ss.reduce((a, b) => a + b.mean_score, 0) / ss.length,
      pass_rate: ss.reduce((a, b) => a + b.pass_rate, 0) / ss.length,
    }))
    .sort((a, b) => a.mean_score - b.mean_score);
}

// ── Retrieval-impact comparison ─────────────────────────────────────

function compareRetrievalImpact(rows: ScenarioRow[]): {
  with_retrieval_mean: number | null;
  without_retrieval_mean: number | null;
  delta: number | null;
  with_count: number;
  without_count: number;
} {
  const withRet = rows.filter((r) => (r.run_metadata.retrieval?.used ?? []).length > 0);
  const withoutRet = rows.filter((r) => (r.run_metadata.retrieval?.used ?? []).length === 0);
  const mean = (xs: ScenarioRow[]) =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b.run_metadata.score.total, 0) / xs.length;
  const wm = mean(withRet);
  const wom = mean(withoutRet);
  return {
    with_retrieval_mean: wm,
    without_retrieval_mean: wom,
    delta: wm !== null && wom !== null ? wm - wom : null,
    with_count: withRet.length,
    without_count: withoutRet.length,
  };
}

// ── Rendering ───────────────────────────────────────────────────────

function renderReport(
  stats: PerScenarioStats[],
  rollup: ReturnType<typeof rollupByCategory>,
  retrievalImpact: ReturnType<typeof compareRetrievalImpact>,
  passThreshold: number,
  totalRows: number,
): string {
  const now = new Date().toISOString();
  const overallMean = stats.length === 0
    ? 0
    : stats.reduce((a, b) => a + b.mean_score, 0) / stats.length;
  const overallPassRate = stats.length === 0
    ? 0
    : stats.filter((s) => s.mean_score >= passThreshold).length / stats.length;

  const lines: string[] = [
    `# Scorecard — ${now}`,
    '',
    `**Pass threshold:** ${(passThreshold * 100).toFixed(0)}%  \\`,
    `**Total scenario runs:** ${totalRows}  \\`,
    `**Distinct scenarios:** ${stats.length}  \\`,
    `**Overall mean score:** ${(overallMean * 100).toFixed(1)}%  \\`,
    `**Overall pass rate:** ${(overallPassRate * 100).toFixed(0)}% of scenarios have mean score ≥ ${(passThreshold * 100).toFixed(0)}%`,
    '',
    '## Per-scenario results',
    '',
    '_Sorted worst-first so gaps surface at the top._',
    '',
    '| Scenario | Category | Reps | Mean | Min | Max | Pass rate | Retrieval used | Last run |',
    '|----------|----------|------|------|-----|-----|-----------|----------------|----------|',
  ];
  for (const s of stats) {
    const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
    const passIcon = s.mean_score >= passThreshold ? '✓' : '✗';
    lines.push(
      `| \`${s.scenario_id}\` | \`${s.primary_category}\` | ${s.reps} | **${pct(s.mean_score)}** ${passIcon} | ${pct(s.min_score)} | ${pct(s.max_score)} | ${pct(s.pass_rate)} | ${s.with_retrieval_used_count}/${s.reps} | ${s.last_ran_at.replace('T', ' ').replace(/\..+$/, '')} |`,
    );
  }
  lines.push('');

  lines.push('## Per-category rollup');
  lines.push('');
  lines.push('_Scenarios grouped by ground-truth primary category. Lower mean = this class is where Emily is weakest._');
  lines.push('');
  lines.push('| Category | Scenarios | Mean score | Pass rate |');
  lines.push('|----------|-----------|------------|-----------|');
  for (const r of rollup) {
    lines.push(`| \`${r.category}\` | ${r.scenarios} | ${(r.mean_score * 100).toFixed(1)}% | ${(r.pass_rate * 100).toFixed(0)}% |`);
  }
  lines.push('');

  lines.push('## Retrieval impact');
  lines.push('');
  lines.push('Compares mean score of runs where the scorer observed Emily using retrieved postmortems (action-pattern match above threshold) vs runs where she did not.');
  lines.push('');
  const ri = retrievalImpact;
  lines.push(`- With-retrieval runs: **${ri.with_count}** runs, mean score ${ri.with_retrieval_mean === null ? 'n/a' : `${(ri.with_retrieval_mean * 100).toFixed(1)}%`}`);
  lines.push(`- Without-retrieval runs: **${ri.without_count}** runs, mean score ${ri.without_retrieval_mean === null ? 'n/a' : `${(ri.without_retrieval_mean * 100).toFixed(1)}%`}`);
  if (ri.delta !== null) {
    lines.push(`- **Delta:** ${(ri.delta * 100).toFixed(1)}% (positive = retrieval helps)`);
    if (ri.with_count < 3 || ri.without_count < 3) {
      lines.push('');
      lines.push('_⚠ Sample size too small for statistical confidence; need ≥3 runs in each bucket for a trustworthy delta._');
    }
  } else {
    lines.push('');
    lines.push('_Insufficient data — need at least one run in each bucket._');
  }
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push('## Interpretation guide');
  lines.push('');
  lines.push(`- **Launch threshold:** ≥${(passThreshold * 100).toFixed(0)}% pass rate on anchor scenarios is plan §17\'s initial launch threshold.`);
  lines.push('- **Worst-first sort:** per-scenario table surfaces gaps for Phase-3 playbook prioritization.');
  lines.push('- **Retrieval delta:** weak or negative delta means the experience base isn\'t helping yet — may indicate retrieval quality issues (embedder, key composition) or that the corpus doesn\'t yet cover relevant precedents.');

  return lines.join('\n') + '\n';
}

// ── Entry ───────────────────────────────────────────────────────────

export async function generateScorecard(): Promise<string> {
  const rows = await fetchScenarioRuns();
  const stats = summarizeByScenario(rows);
  const rollup = rollupByCategory(stats);
  const retrievalImpact = compareRetrievalImpact(rows);

  const md = renderReport(stats, rollup, retrievalImpact, PASS_THRESHOLD, rows.length);
  await mkdir(REPORTS_ROOT, { recursive: true });
  const path = resolve(REPORTS_ROOT, `scorecard-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  await writeFile(path, md, 'utf8');

  // Also write a stable pointer.
  const latestPath = resolve(REPORTS_ROOT, 'scorecard-latest.md');
  await writeFile(latestPath, md, 'utf8');

  console.log(`[scorecard] ${rows.length} scenario runs → ${path}`);
  return path;
}

const isMain = process.argv[1] === __filename;
if (isMain) {
  generateScorecard()
    .then(async () => {
      await closeSql();
    })
    .catch(async (err) => {
      console.error('[scorecard] failed:', err);
      await closeSql();
      process.exit(1);
    });
}
