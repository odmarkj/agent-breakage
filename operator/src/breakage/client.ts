/**
 * Operator-side breakage client.
 *
 * Thin HTTP wrapper around the breakage runner's /retrieve and
 * /capture-postmortem endpoints. Callable from anywhere in Emily's
 * agent loop or tools.
 *
 * No-op-when-unconfigured behavior: if BREAKAGE_RUNNER_URL is not
 * set in the environment, all methods return empty/false without
 * attempting any HTTP. This lets Emily behave identically whether
 * she's running under the scenario framework or in production
 * (eventually production will run with BREAKAGE_RUNNER_URL set to
 * ingest real incident postmortems; not yet).
 *
 * Import this from operator/src/agent.ts (for the pre-action
 * retrieval hook) and operator/src/tools/postmortem.ts (to report
 * Emily's structured postmortem back to the runner). Both callers
 * must treat failures as non-fatal — the breakage runner is
 * observability infrastructure, not a blocking dependency.
 */

export interface RetrievalHit {
  id: string;
  distance: number;
  outcome: 'resolved' | 'regressed' | 'inconclusive';
  source: 'incident-log' | 'scenario' | 'production';
  primary_category: string;
  final_diagnosis: string;
  fix_applied: string;
  what_did_not_work: string[];
}

export interface RetrieveOpts {
  text: string;
  k?: number;
  categories?: string[];
  sources?: Array<'incident-log' | 'scenario' | 'production'>;
}

export interface EmilyPostmortem {
  final_diagnosis: string;
  primary_category: string;
  secondary_categories: string[];
  confidence: number;
  actions_taken: Array<{
    tool: string;
    reversibility: number;
    input_summary: string;
    at: string;
    reverted: boolean;
    revert_reason_mechanical?: string;
  }>;
  fix_applied: string;
  what_did_not_work: string[];
  time_to_diagnose_s: number;
  time_to_fix_s: number;
  side_effects_observed: string[];
  detected_at: string;
}

const BREAKAGE_URL = () => process.env.BREAKAGE_RUNNER_URL ?? null;
const HTTP_TIMEOUT_MS = 5000;

/**
 * Fetch similar past postmortems from the experience base. Returns
 * empty array (not an error) if the runner isn't configured or the
 * call fails — this is pre-action context, not load-bearing.
 */
export async function retrievePast(opts: RetrieveOpts): Promise<RetrievalHit[]> {
  const url = BREAKAGE_URL();
  if (!url) return [];

  try {
    const res = await fetch(`${url}/retrieve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[breakage-client] /retrieve → ${res.status}`);
      return [];
    }
    const body = (await res.json()) as { results?: RetrievalHit[] };
    return body.results ?? [];
  } catch (err) {
    console.warn(`[breakage-client] /retrieve failed: ${(err as Error).message}`);
    return [];
  }
}

export interface EmilyHypothesis {
  primary_category: string;
  secondary_categories: string[];
  confidence: number;
  reasoning: string;
  emitted_at: string;
}

export type ReportPostmortemResult =
  | { captured: true }
  | { captured: false; reason: 'unconfigured' }
  | { captured: false; reason: 'unreachable'; error: string }
  | { captured: false; reason: 'rejected'; status: number; error: string };

export type ReportHypothesisResult =
  | { recorded: true }
  | { recorded: false; reason: 'unconfigured' }
  | { recorded: false; reason: 'unreachable'; error: string }
  | { recorded: false; reason: 'rejected'; status: number; error: string };

/**
 * Report one of Emily's mid-investigation hypotheses to the runner.
 * Fire-and-forget style — the return lets the caller surface failure
 * modes in the tool_result but the emission itself is never
 * load-bearing on Emily's next reasoning step.
 *
 * Cold-path behavior: when unconfigured (no BREAKAGE_RUNNER_URL), the
 * tool just treats the emission as a no-op. Hypotheses only mean
 * anything in the scenario-framework context.
 */
export async function reportHypothesis(h: EmilyHypothesis): Promise<ReportHypothesisResult> {
  const url = BREAKAGE_URL();
  if (!url) return { recorded: false, reason: 'unconfigured' };
  try {
    const res = await fetch(`${url}/capture-hypothesis`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(h),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      console.warn(`[breakage-client] /capture-hypothesis → ${res.status}: ${errorText.slice(0, 200)}`);
      return { recorded: false, reason: 'rejected', status: res.status, error: errorText };
    }
    return { recorded: true };
  } catch (err) {
    const msg = (err as Error).message;
    console.warn(`[breakage-client] /capture-hypothesis failed: ${msg}`);
    return { recorded: false, reason: 'unreachable', error: msg };
  }
}

/**
 * Report Emily's end-of-incident postmortem to the runner. Returns a
 * tagged result so callers (write_postmortem tool) can distinguish:
 *   - captured=true              → runner associated it with the active scenario
 *   - captured=false unconfigured → no BREAKAGE_RUNNER_URL (prod / dev outside scenarios)
 *   - captured=false unreachable  → fetch threw (network error, timeout)
 *   - captured=false rejected     → runner returned non-2xx with an error body
 *
 * The "rejected" case is the one Emily can act on mid-run: a 400 on
 * missing required fields means she should retry with those fields;
 * a 409 means the scenario window already closed and retrying won't
 * help. Earlier versions returned boolean false uniformly, which
 * made 400-errors indistinguishable from unconfigured environments
 * and led Emily to assume success when the runner had rejected her.
 */
export async function reportPostmortem(p: EmilyPostmortem): Promise<ReportPostmortemResult> {
  const url = BREAKAGE_URL();
  if (!url) return { captured: false, reason: 'unconfigured' };

  // The runner's /capture-postmortem expects the full Postmortem
  // schema, so we wrap Emily's fields with framework-managed stubs.
  // The runner fills in incident_id + scenario_id on capture.
  const payload = {
    scenario_id: null as string | null,
    incident_id: '',
    ...p,
    retrieval_consulted: [],
    retrieval_used: [],
    outcome: 'resolved' as const, // placeholder; runner derives from detector
  };

  try {
    const res = await fetch(`${url}/capture-postmortem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      console.warn(`[breakage-client] /capture-postmortem → ${res.status}: ${errorText.slice(0, 200)}`);
      return { captured: false, reason: 'rejected', status: res.status, error: errorText };
    }
    const body = (await res.json()) as { captured?: boolean };
    if (body.captured === true) return { captured: true };
    return { captured: false, reason: 'rejected', status: res.status, error: 'runner returned captured=false' };
  } catch (err) {
    const msg = (err as Error).message;
    console.warn(`[breakage-client] /capture-postmortem failed: ${msg}`);
    return { captured: false, reason: 'unreachable', error: msg };
  }
}

/**
 * Whether a runner URL is configured. Useful for callers that want
 * to conditionally include retrieval context in their prompt.
 */
export function isBreakageEnabled(): boolean {
  return BREAKAGE_URL() !== null;
}
