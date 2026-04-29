/**
 * Prometheus expression handler. Matches:
 *
 *   promql: <PROMQL_QUERY> <op> <value>
 *
 *   error_rate{ns=<NS>} <op> <value>
 *     → translated to a canonical 5xx/total ratio PromQL using the
 *       OTel Demo metric naming (http_server_request_duration_seconds_count
 *       with http_response_status_code label).
 *
 *   cluster_slo_delta <op> <value>
 *   cluster_slo_delta <op> <value> in any out-of-scope namespace
 *     → cluster-wide error-rate increase check; in Phase 1 this is
 *       a simple "any non-scope namespace has > threshold error rate"
 *       check — baseline-delta accounting is Phase-2+.
 *
 * Target URL via env BREAKAGE_PROMETHEUS_URL (default
 * http://127.0.0.1:9090, typically set via port-forward).
 */

import type { ExpressionHandler } from './types.js';

export interface PromHandlerOpts {
  promUrl?: string;
  /**
   * Namespaces considered "in scope" for the current scenario.
   * Used by the cluster_slo_delta expression to filter out the
   * injection target when measuring blast radius.
   */
  scopeNamespaces?: string[];
}

export class PromExpressionHandler implements ExpressionHandler {
  private readonly promUrl: string;
  private readonly scope: Set<string>;

  constructor(opts: PromHandlerOpts = {}) {
    this.promUrl = opts.promUrl ?? process.env.BREAKAGE_PROMETHEUS_URL ?? 'http://127.0.0.1:9090';
    this.scope = new Set(opts.scopeNamespaces ?? []);
  }

  async tryEvaluate(expression: string): Promise<boolean | null> {
    const trimmed = expression.trim();

    // promql: <query> <op> <value>
    if (trimmed.startsWith('promql:')) {
      return this.evalPromQl(trimmed.slice('promql:'.length).trim());
    }

    // error_rate{ns=X} <op> <value>
    const errRate = trimmed.match(/^error_rate\{ns=([^}]+)\}\s*(==|!=|<=|>=|<|>)\s*(.+)$/);
    if (errRate) {
      const [, ns, op, rhs] = errRate;
      return this.evalErrorRate(ns.trim(), op, Number(rhs));
    }

    // cluster_slo_delta <op> <value> [in any out-of-scope namespace]
    const sloDelta = trimmed.match(/^cluster_slo_delta\s*(==|!=|<=|>=|<|>)\s*([^\s]+)(?:\s+in any out-of-scope namespace)?$/);
    if (sloDelta) {
      const [, op, rhs] = sloDelta;
      return this.evalClusterSloDelta(op, Number(rhs));
    }

    return null;
  }

  private async evalPromQl(rest: string): Promise<boolean> {
    // Split from the right: find the last `<op> <value>` pair.
    const m = rest.match(/^(.*)\s(==|!=|<=|>=|<|>)\s(.+)$/);
    if (!m) throw new Error(`promql expression missing <query> <op> <value>: ${rest}`);
    const [, query, op, rhsStr] = m;
    const rhs = Number(rhsStr);
    if (!Number.isFinite(rhs)) throw new Error(`promql rhs must be numeric: ${rhsStr}`);
    const value = await this.instantQuery(query);
    return compareNumeric(value ?? 0, op, rhs);
  }

  private async evalErrorRate(ns: string, op: string, rhs: number): Promise<boolean> {
    // OTel Demo metric naming: http_server_request_duration_seconds_count,
    // label http_response_status_code, service in k8s_namespace_name.
    // Fall back to empty result → 0.
    const num =
      `sum(rate(http_server_request_duration_seconds_count{k8s_namespace_name="${ns}",http_response_status_code=~"5.."}[1m]))`;
    const den =
      `sum(rate(http_server_request_duration_seconds_count{k8s_namespace_name="${ns}"}[1m]))`;
    const query = `(${num}) / (${den})`;
    const value = await this.instantQuery(query);
    return compareNumeric(value ?? 0, op, rhs);
  }

  private async evalClusterSloDelta(op: string, rhs: number): Promise<boolean> {
    // Phase-1 simple check: max error-rate across any namespace NOT
    // in the scenario's scope. Baseline-delta accounting (compare
    // pre-injection vs during-injection rates per namespace) lands
    // in Phase 2 when the runner tracks baselines centrally.
    const exclusions = [...this.scope].map((n) => `k8s_namespace_name!="${n}"`).join(',');
    const selector = exclusions ? `{${exclusions}}` : '';
    const query =
      `max by (k8s_namespace_name) (` +
      `sum by (k8s_namespace_name) (rate(http_server_request_duration_seconds_count${selector ? `{${exclusions},http_response_status_code=~"5.."}` : '{http_response_status_code=~"5.."}'}[1m])) / ` +
      `sum by (k8s_namespace_name) (rate(http_server_request_duration_seconds_count${selector}[1m])))`;
    const value = await this.instantQuery(query);
    return compareNumeric(value ?? 0, op, rhs);
  }

  private async instantQuery(query: string): Promise<number | null> {
    const url = `${this.promUrl}/api/v1/query?query=${encodeURIComponent(query)}`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch (err) {
      // Prom unreachable (not running, wrong URL, port-forward not
      // up). Log and treat as no-data rather than throwing — lets
      // scenarios that don't require Prom continue evaluating their
      // K8s-backed conditions, and scenarios that DO require Prom
      // will correctly fail to satisfy their fixed_when conditions
      // within the time budget.
      console.warn(`[prom-handler] query failed (${(err as Error).message}); treating as no-data`);
      return null;
    }
    if (!res.ok) {
      console.warn(`[prom-handler] query status ${res.status}; treating as no-data`);
      return null;
    }
    const body = (await res.json()) as {
      status: string;
      data: { result: Array<{ value: [number, string] }> };
    };
    const first = body.data?.result?.[0]?.value?.[1];
    if (first === undefined) return null;
    const n = Number(first);
    return Number.isFinite(n) ? n : null;
  }
}

function compareNumeric(lhs: number, op: string, rhs: number): boolean {
  switch (op) {
    case '==': return lhs === rhs;
    case '!=': return lhs !== rhs;
    case '<':  return lhs < rhs;
    case '<=': return lhs <= rhs;
    case '>':  return lhs > rhs;
    case '>=': return lhs >= rhs;
  }
  throw new Error(`unsupported numeric operator: ${op}`);
}
