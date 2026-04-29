/**
 * End-to-end smoke test (manual).
 *
 * Loads the oom-advocate-api scenario, runs the deployment-patch
 * injector against k3d-scenarios, verifies the mutation landed,
 * then calls the Undo to restore the pre-mutation state.
 *
 * This is a human-invoked script, not a scheduled test. Used to
 * confirm the injector + k8s-client + speculative-exec pieces hold
 * together against a real cluster before the /run orchestrator is
 * wired.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScenario } from '../src/runner/load-scenario.js';
import { makeK8sClusterClient } from '../src/speculative-exec/k8s-client.js';
import { InjectorRegistry } from '../src/injector/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main(): Promise<void> {
  const scenarioPath = resolve(__dirname, '../scenarios/anchor/oom-advocate-api.yaml');
  const scenario = await loadScenario(scenarioPath);
  console.log(`[smoke] loaded scenario: ${scenario.id}`);

  const client = makeK8sClusterClient();

  // Peek pre-mutation state.
  const target = { kind: 'Deployment' as const, namespace: 'prod-advocate', name: 'advocate-api' };
  const before = await client.get(target);
  const beforeLimit = (before as Record<string, Record<string, Record<string, Record<string, Record<string, unknown>[]>>>>)
    .spec.template.spec.containers[0].resources;
  console.log(`[smoke] pre-mutation memory limit: ${JSON.stringify(beforeLimit)}`);

  // Inject.
  const registry = new InjectorRegistry(client);
  const undo = await registry.inject(scenario);
  console.log('[smoke] injector applied');

  // Wait briefly, then peek.
  await new Promise((r) => setTimeout(r, 2000));
  const after = await client.get(target);
  const afterLimit = (after as Record<string, Record<string, Record<string, Record<string, Record<string, unknown>[]>>>>)
    .spec.template.spec.containers[0].resources;
  console.log(`[smoke] post-mutation memory limit: ${JSON.stringify(afterLimit)}`);

  // Undo.
  await undo();
  console.log('[smoke] undo applied');

  await new Promise((r) => setTimeout(r, 2000));
  const restored = await client.get(target);
  const restoredLimit = (restored as Record<string, Record<string, Record<string, Record<string, Record<string, unknown>[]>>>>)
    .spec.template.spec.containers[0].resources;
  console.log(`[smoke] restored memory limit: ${JSON.stringify(restoredLimit)}`);

  console.log('[smoke] done');
}

main().catch((err) => {
  console.error('[smoke] failed:', err);
  process.exit(1);
});
