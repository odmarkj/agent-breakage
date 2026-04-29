/**
 * Scorecard batch runner.
 *
 * Runs all scenarios (filtered by tier) at N repetitions by POSTing
 * each to the live runner /run endpoint. Captures the JSON response
 * and persists it for the report step (postmortems are already
 * persisted by the orchestrator itself; this just writes a
 * per-batch summary file).
 *
 * Requires:
 *   - runner up on BREAKAGE_RUNNER_URL (default http://127.0.0.1:8088)
 *   - target applications in place (e.g., prod-advocate namespace)
 *   - for OTel-backed scenarios, OTel Demo up (./scripts/target-otel-demo.sh up)
 *
 * Usage (once wired as npm script):
 *   npm run batch -- --tier=anchor --reps=3
 *   npm run batch -- --tier=anchor --reps=5 --scenario=oom-advocate-api-k8s-only
 *
 * This is the harness the plan §14 repetition counts (3 during
 * buildout, 5 for scorecard-of-record) plug into. The --scenario
 * flag allows focused re-runs of a single scenario after fixing it.
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Postmortem } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RUNNER_URL = process.env.BREAKAGE_RUNNER_URL ?? 'http://127.0.0.1:8088';
const REPORTS_ROOT = resolve(__dirname, '../../reports');

interface BatchOpts {
  tier?: 'anchor' | 'coverage' | 'retired';
  reps: number;
  scenarioFilter?: string;
  /**
   * Path to a JSON file with { "<scenario_id>": {...postmortem} }
   * used by the stub mode. Phase-1-Week-2 replaces this by capturing
   * Emily's actual event stream.
   */
  stubPostmortemsPath?: string;
}

interface RunResult {
  scenario_id: string;
  incident_id: string;
  score_total: number;
  detector_fixed: boolean;
  detector_regressions: string[];
  elapsed_ms: number;
  error?: string;
}

export async function runBatch(opts: BatchOpts): Promise<void> {
  const startedAt = new Date().toISOString();
  const scenarios = await listScenarios(opts.tier);
  const filtered = opts.scenarioFilter
    ? scenarios.filter((s) => s.id === opts.scenarioFilter)
    : scenarios;

  if (filtered.length === 0) {
    console.warn('[batch] no scenarios matched; exiting');
    return;
  }

  const stubPostmortems = opts.stubPostmortemsPath
    ? await readStubPostmortems(opts.stubPostmortemsPath)
    : {};

  console.log(`[batch] running ${filtered.length} scenario(s) × ${opts.reps} rep(s)`);

  const results: RunResult[] = [];
  for (const s of filtered) {
    const postmortem = stubPostmortems[s.id] ?? defaultStubPostmortem(s.id);
    for (let rep = 1; rep <= opts.reps; rep++) {
      const start = Date.now();
      try {
        const res = await fetch(`${RUNNER_URL}/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scenarioId: s.id, postmortem }),
          signal: AbortSignal.timeout(1_000_000),
        });
        const body = (await res.json()) as {
          scenario_id?: string;
          incident_id?: string;
          score?: { total?: number };
          detector?: { fixed?: boolean; regressions?: string[] };
          error?: string;
        };
        const elapsed = Date.now() - start;
        results.push({
          scenario_id: body.scenario_id ?? s.id,
          incident_id: body.incident_id ?? '',
          score_total: body.score?.total ?? 0,
          detector_fixed: body.detector?.fixed ?? false,
          detector_regressions: body.detector?.regressions ?? [],
          elapsed_ms: elapsed,
          error: body.error,
        });
        const tag = body.error ? `ERR ${body.error}` : `score=${(body.score?.total ?? 0).toFixed(2)}`;
        console.log(`[batch] ${s.id} rep ${rep}/${opts.reps}: ${tag} (${elapsed}ms)`);
      } catch (err) {
        const elapsed = Date.now() - start;
        results.push({
          scenario_id: s.id,
          incident_id: '',
          score_total: 0,
          detector_fixed: false,
          detector_regressions: [],
          elapsed_ms: elapsed,
          error: err instanceof Error ? err.message : String(err),
        });
        console.log(`[batch] ${s.id} rep ${rep}/${opts.reps}: ERR ${(err as Error).message} (${elapsed}ms)`);
      }
    }
  }

  await mkdir(REPORTS_ROOT, { recursive: true });
  const batchPath = resolve(REPORTS_ROOT, `batch-${startedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(
    batchPath,
    JSON.stringify({ started_at: startedAt, opts, results }, null, 2),
    'utf8',
  );
  console.log(`[batch] done. summary: ${batchPath}`);
}

// ── helpers ─────────────────────────────────────────────────────────

async function listScenarios(tier?: string): Promise<Array<{ id: string; tier: string }>> {
  const res = await fetch(`${RUNNER_URL}/scenarios`);
  if (!res.ok) throw new Error(`${RUNNER_URL}/scenarios → ${res.status}`);
  const body = (await res.json()) as { scenarios: Array<{ id: string; tier: string }> };
  return tier ? body.scenarios.filter((s) => s.tier === tier) : body.scenarios;
}

async function readStubPostmortems(path: string): Promise<Record<string, Postmortem>> {
  const text = await readFile(path, 'utf8');
  return JSON.parse(text) as Record<string, Postmortem>;
}

/**
 * Generic stub postmortem — claims the correct ground-truth
 * category via a tautology (framework injects scenario_id + ground
 * truth at the runner layer anyway, but the stub needs *some*
 * shape to pass validation). Useful ONLY for smoke-testing the
 * pipeline; real scoring requires Emily-authored postmortems.
 */
function defaultStubPostmortem(scenarioId: string): Postmortem {
  const now = new Date().toISOString();
  return {
    scenario_id: scenarioId,
    incident_id: '',
    detected_at: now,
    final_diagnosis: `[stub] ${scenarioId}: Emily's postmortem not yet wired — replace this stub when operator integration lands`,
    primary_category: 'application-error-uncaught-exception',
    secondary_categories: [],
    confidence: 0.5,
    actions_taken: [
      {
        tool: 'kubectl_get',
        reversibility: 0,
        input_summary: '[stub]',
        at: now,
        reverted: false,
      },
    ],
    fix_applied: '[stub] no fix applied; this is a scaffolding run',
    what_did_not_work: [],
    time_to_diagnose_s: 0,
    time_to_fix_s: 0,
    side_effects_observed: [],
    retrieval_consulted: [],
    retrieval_used: [],
    outcome: 'inconclusive',
  };
}

// ── entry point ─────────────────────────────────────────────────────

const isMain = process.argv[1] === __filename;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  runBatch({
    tier: args.tier as BatchOpts['tier'],
    reps: Number(args.reps ?? 3),
    scenarioFilter: args.scenario,
    stubPostmortemsPath: args['stubs'],
  }).catch((err) => {
    console.error('[batch] failed:', err);
    process.exit(1);
  });
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
