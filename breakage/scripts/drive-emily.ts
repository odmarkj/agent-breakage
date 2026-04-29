/**
 * End-to-end integration driver.
 *
 * Invokes Emily's real `runAgent` loop (imported from the operator
 * package) against a scenario. Simulates what would happen when
 * Emily's Kubernetes watcher picks up the scenario's injected
 * failure: we feed her a synthetic "user message" describing the
 * symptom, let her real agent loop consult the breakage runner's
 * /retrieve, make tool calls against the k3d cluster, and emit a
 * postmortem via write_postmortem (which POSTs to
 * /capture-postmortem).
 *
 * Required env:
 *   ANTHROPIC_API_KEY          Emily's LLM creds
 *   BREAKAGE_RUNNER_URL        Where Emily's retrieval + postmortem
 *                              calls go (default http://127.0.0.1:8088)
 *   DATABASE_URL               Operator's own DB (operator_test)
 *   KUBECONFIG                 k3d-scenarios kubeconfig
 *   OPERATOR_MODEL (optional)  Override; defaults to haiku for
 *                              cost-efficient smoke tests
 *   SPECULATIVE_EXEC (optional) "enabled" to route tier-2 tools
 *                              through the speculative-exec wrapper
 *
 * Usage:
 *   tsx scripts/drive-emily.ts <scenario-id> ["<message-to-emily>"]
 *
 * Example:
 *   tsx scripts/drive-emily.ts oom-advocate-api-k8s-only \
 *     "Pods in prod-advocate are OOMKilling; investigate and restore"
 */

import { runAgent } from '../../operator/src/agent.js';
import type { ChatRequest, SSEEvent } from '../../operator/src/types.js';
import { initSchema } from '../../operator/src/db.js';

const RUNNER_URL = process.env.BREAKAGE_RUNNER_URL ?? 'http://127.0.0.1:8088';

async function main(): Promise<void> {
  const scenarioId = process.argv[2];
  if (!scenarioId) {
    console.error('usage: drive-emily.ts <scenario-id> ["<message>"]');
    process.exit(2);
  }
  const userMessage =
    process.argv[3]
    ?? [
      'An alert just fired: advocate-api in namespace prod-advocate has degraded — pods are not staying Ready and the deployment is unhealthy. Investigate and fix if you can.',
      '',
      'Investigate broadly before narrowing. Check pod status, recent events, pod logs (including --previous for crashed containers), Secret contents (decode base64 before drawing conclusions), ConfigMaps, and the Deployment spec. The fault could live in any of these — do not assume one layer is more likely than another. Read twice, write once.',
      '',
      'All tool tiers (1, 2, and 3) are available in this environment. Tier-3 tools (kubectl_apply, kubectl_delete, helm_upgrade, helm_rollback, postgres_query) route through an approval flow; see your system prompt\'s "Operational environment" section for the current regime. Use them when you need them.',
      '',
      'When you finish investigating, ALWAYS call write_postmortem with:',
      '  - final_diagnosis (what was wrong in one paragraph)',
      '  - primary_category (from the root-cause vocabulary: resource-limit-misconfiguration, secret-content-mismatch, deployment-rollout-failure, application-error-uncaught-exception, etc.)',
      '  - secondary_categories (optional)',
      '  - actions_taken (ordered list of tools you invoked, with reversibility)',
      '  - fix_applied (what actually restored the service, or "escalated" if you couldn\'t)',
      '  - what_did_not_work (hypotheses you pursued that were wrong — high-signal training data)',
      '  - confidence (0-1)',
      '  - time_to_diagnose_s, time_to_fix_s, side_effects_observed',
      '',
      'Calling write_postmortem is non-optional — the framework uses your postmortem as ground-truth against its observations. Skip it and your run scores 0 on the detected/diagnosed axes.',
    ].join('\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is required');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgresql://operator_test:operator-test-changeme@127.0.0.1:5432/operator_test';
  }
  process.env.BREAKAGE_RUNNER_URL = RUNNER_URL;
  process.env.OPERATOR_MODEL = process.env.OPERATOR_MODEL ?? 'claude-haiku-4-5-20251001';

  console.log(`[drive-emily] scenario=${scenarioId}`);
  console.log(`[drive-emily] model=${process.env.OPERATOR_MODEL}`);
  console.log(`[drive-emily] spec-exec=${process.env.SPECULATIVE_EXEC ?? 'disabled'}`);
  console.log(`[drive-emily] runner=${RUNNER_URL}`);

  // Initialize Emily's schema (idempotent — operator uses CREATE IF NOT EXISTS).
  await initSchema();
  console.log('[drive-emily] operator schema ready');

  // Kick off /run in await mode. The runner injects the fault and
  // will block on /capture-postmortem (with time-budget timeout).
  //
  // undici's default headersTimeout is 300s. Scenarios with
  // time_budget_s ≥ 300 (oom, image-pull, secret-missing-key all
  // set to 600s) exceed it, so drive-emily would error with
  // UND_ERR_HEADERS_TIMEOUT and exit BEFORE the runner's
  // orchestrator clears the active-scenario lock — leaving the
  // next scenario-run.sh invocation locked out with "already
  // active". We use a per-request undici Agent with a longer
  // headersTimeout that covers the longest scenario budget + a
  // reasonable grace period.
  const { Agent, fetch: undiciFetch } = await import('undici');
  const runFetchDispatcher = new Agent({
    headersTimeout: 900_000,
    bodyTimeout: 900_000,
  });
  const runPromise = (async () => {
    const res = await undiciFetch(`${RUNNER_URL}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId }),
      dispatcher: runFetchDispatcher,
    });
    return res.json();
  })();

  // Give the injector a moment to apply before Emily starts.
  await sleep(2000);
  console.log('[drive-emily] injection applied; starting Emily agent loop');

  // Drive Emily's agent loop with the synthetic symptom message.
  const request: ChatRequest = {
    message: userMessage,
    userRole: 'admin',
    userId: 'drive-emily-harness',
  };

  const toolCalls: string[] = [];
  let tokenCount = 0;
  let done = false;

  try {
    for await (const ev of runAgent(request) as AsyncGenerator<SSEEvent>) {
      switch (ev.type) {
        case 'token':
          tokenCount += ev.content.length;
          process.stdout.write(ev.content);
          break;
        case 'tool_call':
          toolCalls.push(ev.toolName);
          process.stdout.write(`\n[tool_call] ${ev.toolName} ${JSON.stringify(ev.toolInput).slice(0, 160)}\n`);
          break;
        case 'tool_result': {
          const r = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result);
          process.stdout.write(`[tool_result] ${ev.toolName} → ${r.slice(0, 300)}${r.length > 300 ? '…' : ''}\n`);
          break;
        }
        case 'approval_required':
          process.stdout.write(`\n[approval_required] ${ev.toolName} ${ev.description}\n`);
          // In this harness we auto-abort on tier-3 — scenarios
          // should be tier-2-only for the initial driver test.
          break;
        case 'error':
          process.stdout.write(`\n[error] ${ev.content}\n`);
          break;
        case 'done':
          done = true;
          process.stdout.write(`\n[done]\n`);
          break;
      }
    }
  } catch (err) {
    console.error('[drive-emily] agent loop error:', err);
  }

  console.log(`\n[drive-emily] agent loop ended: done=${done} tool-calls=${toolCalls.length} tokens~${tokenCount}`);
  console.log(`[drive-emily] tools called in order: ${toolCalls.join(', ')}`);

  // Await the scorecard.
  console.log('[drive-emily] awaiting scorecard from runner…');
  const scorecard = (await runPromise) as Record<string, unknown>;
  console.log('---');
  console.log('SCORECARD:');
  console.log(JSON.stringify(scorecard, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('[drive-emily] failed:', err);
  process.exit(1);
});
