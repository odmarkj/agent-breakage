/**
 * Synthetic-approver client for Emily's agent loop.
 *
 * When `SYNTH_APPROVER_URL` is set (typically during breakage
 * scenario runs), tier-3 approvals route through the synthetic
 * approver service instead of blocking for human Slack clicks.
 * Synthetic approver audit shape is identical to the real Slack
 * approver's — scenario traces remain commensurable with
 * production traces.
 *
 * Current call pattern:
 *   1. POST {SYNTH_APPROVER_URL}/request with tool + input
 *   2. Poll {SYNTH_APPROVER_URL}/status/:id until decided or timeout
 *   3. Return the final decision
 *
 * No-op when SYNTH_APPROVER_URL isn't set — caller falls back to
 * the async Slack-approval flow (current production path).
 */

export type ApprovalDecision =
  | { kind: 'approved'; approverId: string; delayMs: number }
  | { kind: 'denied'; approverId: string; reason: string; delayMs: number }
  | { kind: 'timeout' };

interface RequestResponse {
  id: string;
  status: 'pending' | 'approved' | 'denied';
  expected_delay_ms?: number;
}

interface StatusResponse {
  id: string;
  status: 'pending' | 'approved' | 'denied';
  decided_at?: string;
  decided_by?: string;
  decision_delay_ms?: number;
  reason?: string;
}

const URL_ENV = () => process.env.SYNTH_APPROVER_URL ?? null;
const POLL_INTERVAL_MS = Number(process.env.SYNTH_APPROVER_POLL_MS ?? 250);
const MAX_WAIT_MS = Number(process.env.SYNTH_APPROVER_TIMEOUT_MS ?? 30_000);

export function isSyntheticApprovalEnabled(): boolean {
  return URL_ENV() !== null;
}

export async function requestSyntheticApproval(params: {
  tool: string;
  toolInput: Record<string, unknown>;
  scenarioId?: string | null;
}): Promise<ApprovalDecision> {
  const base = URL_ENV();
  if (!base) return { kind: 'timeout' };

  // POST /request
  let requestBody: RequestResponse;
  try {
    const res = await fetch(`${base}/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: params.tool,
        tool_input: params.toolInput,
        scenario_id: params.scenarioId ?? process.env.BREAKAGE_SCENARIO_ID ?? null,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[synth-approval] /request → ${res.status}`);
      return { kind: 'timeout' };
    }
    requestBody = (await res.json()) as RequestResponse;
  } catch (err) {
    console.warn(`[synth-approval] /request failed: ${(err as Error).message}`);
    return { kind: 'timeout' };
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const res = await fetch(`${base}/status/${requestBody.id}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) continue;
      const status = (await res.json()) as StatusResponse;
      if (status.status === 'approved') {
        return {
          kind: 'approved',
          approverId: status.decided_by ?? 'synthetic',
          delayMs: status.decision_delay_ms ?? 0,
        };
      }
      if (status.status === 'denied') {
        return {
          kind: 'denied',
          approverId: status.decided_by ?? 'synthetic',
          reason: status.reason ?? 'synthetic-denial',
          delayMs: status.decision_delay_ms ?? 0,
        };
      }
    } catch {
      // network blip; keep polling
    }
  }

  return { kind: 'timeout' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
