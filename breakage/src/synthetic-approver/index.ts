/**
 * Synthetic approver service.
 *
 * Stands in for the human who clicks Approve/Deny on Emily's
 * tier-3 Slack messages. Exists so scenarios that include tier-3
 * tool calls can run hands-off: no human has to watch #k3s during
 * 100 scenarios/day of baseline runs.
 *
 * Per plan §7: configurable response delay (realistic Slack timing)
 * and configurable deny rate (to test Emily's denial-recovery
 * behavior). Emits the same audit log shape as a real human
 * approver so downstream traces are commensurable.
 *
 * Two HTTP modes:
 *
 *   1. POST /request — Emily's tier-3 gate calls this with the
 *      tool + input payload. Server schedules a decision after
 *      the configured delay and returns an approval id immediately.
 *
 *   2. GET  /status/:id — polled by Emily's gate to see whether
 *      the decision has landed. Response shape:
 *        { status: "pending" | "approved" | "denied", ... }
 *
 * Configuration (env):
 *   SYNTH_APPROVER_PORT            default 8089
 *   SYNTH_APPROVER_DELAY_MIN_MS    default 1000
 *   SYNTH_APPROVER_DELAY_MAX_MS    default 5000
 *   SYNTH_APPROVER_DENY_RATE       default 0.0  (0.0-1.0)
 *   SYNTH_APPROVER_USER            default "slack:synthetic-approver"
 *
 * This is deliberately simple: no persistence, no retries, no
 * multi-instance. Scenario runs are single-process sessions, so
 * in-memory state is fine.
 */

import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';

const PORT = Number(process.env.SYNTH_APPROVER_PORT ?? 8089);
const DELAY_MIN_MS = Number(process.env.SYNTH_APPROVER_DELAY_MIN_MS ?? 1000);
const DELAY_MAX_MS = Number(process.env.SYNTH_APPROVER_DELAY_MAX_MS ?? 5000);
const DENY_RATE = Number(process.env.SYNTH_APPROVER_DENY_RATE ?? 0);
const APPROVER_USER = process.env.SYNTH_APPROVER_USER ?? 'slack:synthetic-approver';

interface ApprovalRecord {
  id: string;
  requested_at: string;
  tool: string;
  tool_input: Record<string, unknown>;
  scenario_id: string | null;
  status: 'pending' | 'approved' | 'denied';
  decided_at?: string;
  decided_by?: string;
  decision_delay_ms?: number;
  reason?: string;
}

const records = new Map<string, ApprovalRecord>();
const auditLog: ApprovalRecord[] = [];

const app = Fastify({ logger: true });

// ── Request endpoint ────────────────────────────────────────────────

interface RequestBody {
  tool: string;
  tool_input: Record<string, unknown>;
  scenario_id?: string;
  /** Force a specific decision, overriding deny-rate. Useful for tests. */
  force?: 'approve' | 'deny';
  /** Override delay for this specific request (ms). */
  delay_ms?: number;
}

app.post<{ Body: RequestBody }>('/request', async (req, reply) => {
  const body = req.body ?? ({} as RequestBody);
  if (!body.tool) {
    reply.code(400);
    return { error: 'tool is required' };
  }

  const id = randomUUID();
  const requestedAt = new Date().toISOString();
  const delay = body.delay_ms ?? (DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));

  const record: ApprovalRecord = {
    id,
    requested_at: requestedAt,
    tool: body.tool,
    tool_input: body.tool_input ?? {},
    scenario_id: body.scenario_id ?? null,
    status: 'pending',
  };
  records.set(id, record);

  const decidedBy = APPROVER_USER;

  setTimeout(() => {
    const current = records.get(id);
    if (!current) return;
    const deny = body.force === 'deny'
      ? true
      : body.force === 'approve'
      ? false
      : Math.random() < DENY_RATE;
    current.status = deny ? 'denied' : 'approved';
    current.decided_at = new Date().toISOString();
    current.decided_by = decidedBy;
    current.decision_delay_ms = Math.round(delay);
    if (deny) current.reason = 'synthetic-denial (simulated human denial for denial-recovery test)';
    auditLog.push({ ...current });
  }, delay);

  return { id, status: 'pending', expected_delay_ms: Math.round(delay) };
});

// ── Status endpoint ─────────────────────────────────────────────────

app.get<{ Params: { id: string } }>('/status/:id', async (req, reply) => {
  const record = records.get(req.params.id);
  if (!record) {
    reply.code(404);
    return { error: 'approval id not found' };
  }
  return record;
});

// ── Audit log ───────────────────────────────────────────────────────

app.get('/audit', async () => ({
  count: auditLog.length,
  approver: APPROVER_USER,
  configured: {
    delay_min_ms: DELAY_MIN_MS,
    delay_max_ms: DELAY_MAX_MS,
    deny_rate: DENY_RATE,
  },
  records: auditLog,
}));

// ── Health ──────────────────────────────────────────────────────────

app.get('/health', async () => ({
  ok: true,
  service: 'synthetic-approver',
  time: new Date().toISOString(),
  pending: Array.from(records.values()).filter((r) => r.status === 'pending').length,
  decided: auditLog.length,
}));

// ── Entry ───────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('synthetic-approver/index.ts')
            || process.argv[1]?.endsWith('synthetic-approver/index.js');
if (isMain) {
  app
    .listen({ port: PORT, host: '0.0.0.0' })
    .then(() => {
      app.log.info(
        `[synth-approver] listening on :${PORT} — delay ${DELAY_MIN_MS}-${DELAY_MAX_MS}ms, ` +
          `deny_rate ${DENY_RATE}, approver "${APPROVER_USER}"`,
      );
    })
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}

export { app };
