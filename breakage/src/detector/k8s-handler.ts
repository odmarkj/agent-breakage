/**
 * K8s API expression handler. Matches:
 *
 *   deployment.<ns>.<name>.readyReplicas == desiredReplicas
 *   deployment.<ns>.<name>.readyReplicas == <N>
 *   pod.<ns>.<name>.phase == <phase>
 *
 * The name may contain dots if it has to — this handler uses a
 * greedy rightmost-field strategy: it splits on ' ' first, then
 * parses the LHS as `<kind>.<ns>.<rest>.<field>` where `<rest>` is
 * allowed to contain dots (it becomes the resource name).
 */

import * as k8s from '@kubernetes/client-node';
import type { ExpressionHandler } from './types.js';

export class K8sExpressionHandler implements ExpressionHandler {
  private readonly appsV1: k8s.AppsV1Api;
  private readonly coreV1: k8s.CoreV1Api;

  constructor(kc: k8s.KubeConfig) {
    this.appsV1 = kc.makeApiClient(k8s.AppsV1Api);
    this.coreV1 = kc.makeApiClient(k8s.CoreV1Api);
  }

  async tryEvaluate(expression: string): Promise<boolean | null> {
    const parts = expression.trim().split(/\s+/);
    if (parts.length < 3) return null;
    const lhs = parts[0];
    const op = parts[1];
    const rhs = parts.slice(2).join(' ');

    const lhsSegments = lhs.split('.');
    if (lhsSegments.length < 4) return null;

    const kind = lhsSegments[0];
    const ns = lhsSegments[1];
    const field = lhsSegments[lhsSegments.length - 1];
    const name = lhsSegments.slice(2, -1).join('.');

    if (kind === 'deployment') {
      return this.evalDeployment(ns, name, field, op, rhs);
    }
    if (kind === 'pod') {
      return this.evalPod(ns, name, field, op, rhs);
    }
    return null;
  }

  private async evalDeployment(
    ns: string,
    name: string,
    field: string,
    op: string,
    rhs: string,
  ): Promise<boolean> {
    let d;
    try {
      d = await this.appsV1.readNamespacedDeployment({ name, namespace: ns });
    } catch (err) {
      // Deployment not found → condition can't be satisfied.
      if ((err as { code?: number }).code === 404) return false;
      throw err;
    }
    const ready = d.status?.readyReplicas ?? 0;
    const desired = d.spec?.replicas ?? 0;

    if (field === 'readyReplicas') {
      if (rhs === 'desiredReplicas') return compareNumeric(ready, op, desired);
      const n = Number(rhs);
      if (Number.isFinite(n)) return compareNumeric(ready, op, n);
      throw new Error(`deployment.${name}.readyReplicas compared against non-numeric "${rhs}"`);
    }
    if (field === 'desiredReplicas' || field === 'replicas') {
      const n = Number(rhs);
      if (Number.isFinite(n)) return compareNumeric(desired, op, n);
    }
    throw new Error(`unsupported deployment field "${field}"`);
  }

  private async evalPod(
    ns: string,
    name: string,
    field: string,
    op: string,
    rhs: string,
  ): Promise<boolean> {
    let p;
    try {
      p = await this.coreV1.readNamespacedPod({ name, namespace: ns });
    } catch (err) {
      if ((err as { code?: number }).code === 404) return false;
      throw err;
    }
    if (field === 'phase') {
      const phase = p.status?.phase ?? '';
      return compareString(phase, op, stripQuotes(rhs));
    }
    throw new Error(`unsupported pod field "${field}"`);
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
  throw new Error(`unsupported numeric comparison operator: ${op}`);
}

function compareString(lhs: string, op: string, rhs: string): boolean {
  switch (op) {
    case '==': return lhs === rhs;
    case '!=': return lhs !== rhs;
  }
  throw new Error(`unsupported string comparison operator: ${op}`);
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
