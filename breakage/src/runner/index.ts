/**
 * Scenario runner HTTP server.
 *
 *   GET  /health                     liveness
 *   GET  /scenarios                  list all loaded scenario YAMLs
 *   POST /run                        execute a scenario
 *   POST /run/:scenarioId            same, shorthand
 *
 * Orchestration lives in ./orchestrator.ts. This file is the HTTP
 * surface + scenario discovery + dependency wiring.
 */

import { readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { loadScenario } from './load-scenario.js';
import { Orchestrator } from './orchestrator.js';
import { makeK8sClusterClient } from '../speculative-exec/k8s-client.js';
import { InjectorRegistry } from '../injector/index.js';
import { ExpressionEvaluator } from '../detector/index.js';
import { retrieve } from '../experience-base/retrieval.js';
import {
  activeScenarioId,
  activeSnapshot,
  captureAndResolve,
  hasActive,
  recordHypothesis,
  type CapturedHypothesis,
} from './active-scenario.js';
import type { Postmortem, Scenario } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCENARIOS_ROOT = resolve(__dirname, '../../scenarios');
const PORT = Number(process.env.BREAKAGE_PORT ?? 8088);

const app = Fastify({ logger: true });

// ── dependency wiring ──────────────────────────────────────────────
//
// Cluster client + registries are lazy: the runner only needs them
// when /run is invoked, so a misconfigured KUBECONFIG shouldn't block
// /health and /scenarios.

let _orchestrator: Orchestrator | null = null;

function getOrchestrator(): Orchestrator {
  if (_orchestrator) return _orchestrator;
  const client = makeK8sClusterClient();
  const registry = new InjectorRegistry(client);
  const evaluator = new ExpressionEvaluator();
  _orchestrator = new Orchestrator({ client, registry, evaluator });
  return _orchestrator;
}

// ── routes ─────────────────────────────────────────────────────────

app.get('/health', async () => ({
  ok: true,
  service: 'k3s-breakage',
  time: new Date().toISOString(),
  active_scenario: activeSnapshot(),
}));

// ── External surface for Emily ─────────────────────────────────────
//
// Emily (or any client) can consult the experience base pre-action:
//
//   POST /retrieve { text, k?, categories?, sources? }
//
// And report a structured postmortem that the runner associates with
// the currently-active scenario (if any):
//
//   POST /capture-postmortem <Postmortem>

interface RetrieveBody {
  text: string;
  k?: number;
  categories?: string[];
  sources?: Array<'incident-log' | 'scenario' | 'production'>;
  maxDistance?: number;
  poolCap?: number;
}

app.post<{ Body: RetrieveBody }>('/retrieve', async (req, reply) => {
  const body = req.body ?? ({} as RetrieveBody);
  if (!body.text || typeof body.text !== 'string') {
    reply.code(400);
    return { error: 'text is required (string)' };
  }
  try {
    const results = await retrieve({
      text: body.text,
      k: body.k,
      categories: body.categories,
      sources: body.sources,
      maxDistance: body.maxDistance,
      poolCap: body.poolCap,
    });
    return {
      count: results.length,
      results: results.map((r) => ({
        id: r.id,
        distance: r.distance,
        outcome: r.outcome,
        source: r.source,
        primary_category: r.postmortem.primary_category,
        final_diagnosis: r.postmortem.final_diagnosis,
        fix_applied: r.postmortem.fix_applied,
        what_did_not_work: r.postmortem.what_did_not_work,
      })),
    };
  } catch (err) {
    app.log.error(err);
    reply.code(500);
    return { error: err instanceof Error ? err.message : String(err) };
  }
});

app.post<{ Body: Postmortem }>('/capture-postmortem', async (req, reply) => {
  const postmortem = req.body;
  if (!postmortem || !postmortem.primary_category || !postmortem.final_diagnosis) {
    reply.code(400);
    return { error: 'postmortem with primary_category and final_diagnosis required' };
  }
  if (!hasActive()) {
    reply.code(409);
    return {
      error: 'no active scenario — /capture-postmortem can only be called during a /run',
    };
  }
  const scenario_id = captureAndResolve(postmortem);
  return { captured: true, scenario_id };
});

// Emily's emit_hypothesis tool POSTs here mid-investigation. Unlike
// /capture-postmortem this is additive (multiple per run) and never
// resolves the active-scenario promise. Hypotheses are surfaced to
// the scorer alongside the final postmortem for disagreement flags.
app.post<{ Body: CapturedHypothesis }>('/capture-hypothesis', async (req, reply) => {
  const h = req.body;
  if (!h || !h.primary_category || !h.reasoning) {
    reply.code(400);
    return { error: 'hypothesis requires primary_category and reasoning' };
  }
  if (!hasActive()) {
    reply.code(409);
    return {
      error: 'no active scenario — /capture-hypothesis can only be called during a /run',
    };
  }
  const scenario_id = recordHypothesis({
    primary_category: String(h.primary_category).trim(),
    secondary_categories: Array.isArray(h.secondary_categories) ? h.secondary_categories : [],
    confidence: typeof h.confidence === 'number' ? h.confidence : 0.5,
    reasoning: String(h.reasoning).trim(),
    emitted_at: h.emitted_at ?? new Date().toISOString(),
  });
  return { recorded: true, scenario_id };
});

app.get('/scenarios', async () => {
  const scenarios = await listScenarios();
  return {
    count: scenarios.length,
    scenarios: scenarios.map((s) => ({
      id: s.id,
      tier: s.tier,
      plane: s.plane,
      symptom_class: s.symptom_class,
      source_tranche: s.source_tranche,
      status: s.status,
      difficulty: s.difficulty,
    })),
  };
});

interface RunBody {
  scenarioId: string;
  /**
   * Optional. If provided → stub mode (postmortem supplied directly,
   * for smoke tests). If omitted → await mode (runner waits for
   * Emily to POST her postmortem to /capture-postmortem within
   * the scenario's time_budget_s).
   */
  postmortem?: Postmortem;
}

app.post<{ Body: RunBody }>('/run', async (req, reply) => {
  const body = req.body ?? ({} as RunBody);
  if (!body.scenarioId) {
    reply.code(400);
    return { error: 'scenarioId is required' };
  }

  const scenario = await findScenarioById(body.scenarioId);
  if (!scenario) {
    reply.code(404);
    return { error: `scenario "${body.scenarioId}" not found` };
  }

  try {
    const orchestrator = getOrchestrator();
    const run = await orchestrator.run({ scenario, postmortem: body.postmortem });
    return run;
  } catch (err) {
    app.log.error(err);
    reply.code(500);
    return { error: err instanceof Error ? err.message : String(err) };
  }
});

// ── scenario discovery ─────────────────────────────────────────────

async function listScenarios(): Promise<Scenario[]> {
  const out: Scenario[] = [];
  await walk(resolve(SCENARIOS_ROOT, 'anchor'), out).catch(noop);
  const coverageRoot = resolve(SCENARIOS_ROOT, 'coverage');
  const tranches = await readdir(coverageRoot, { withFileTypes: true }).catch(() => []);
  for (const t of tranches) {
    if (!t.isDirectory()) continue;
    await walk(resolve(coverageRoot, t.name), out).catch(noop);
  }
  return out;
}

async function findScenarioById(id: string): Promise<Scenario | null> {
  const all = await listScenarios();
  return all.find((s) => s.id === id) ?? null;
}

async function walk(dir: string, out: Scenario[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!(e.name.endsWith('.yaml') || e.name.endsWith('.yml'))) continue;
    try {
      const s = await loadScenario(resolve(dir, e.name));
      out.push(s);
    } catch (err) {
      app.log.warn({ err, file: e.name }, 'scenario load failed');
    }
  }
}

function noop(): void { /* swallow */ }

// ── entry point ────────────────────────────────────────────────────

const isMain = process.argv[1] === __filename;
if (isMain) {
  app
    .listen({ port: PORT, host: '0.0.0.0' })
    .then(() => app.log.info(`[runner] listening on :${PORT}`))
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}

export { app };
