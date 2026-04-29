/**
 * Evaluator composes expression handlers and provides the
 * sustained-for-s polling wrapper used by the scenario runner.
 */

import * as k8s from '@kubernetes/client-node';
import type { DetectorCondition } from '../types/index.js';
import { K8sExpressionHandler } from './k8s-handler.js';
import { PromExpressionHandler, type PromHandlerOpts } from './prom-handler.js';
import type { Evaluator, ExpressionHandler, SustainedEvaluator } from './types.js';

export interface EvaluatorOpts {
  kubeconfig?: k8s.KubeConfig;
  promOpts?: PromHandlerOpts;
  /** Extra handlers, tried after built-ins. */
  extra?: ExpressionHandler[];
}

export class ExpressionEvaluator implements Evaluator, SustainedEvaluator {
  private readonly handlers: ExpressionHandler[];

  constructor(opts: EvaluatorOpts = {}) {
    const kc = opts.kubeconfig ?? new k8s.KubeConfig();
    if (!opts.kubeconfig) {
      const override = process.env.BREAKAGE_KUBECONFIG;
      if (override) kc.loadFromFile(override);
      else kc.loadFromDefault();
    }

    this.handlers = [
      new K8sExpressionHandler(kc),
      new PromExpressionHandler(opts.promOpts ?? {}),
      ...(opts.extra ?? []),
    ];
  }

  async evaluate(expression: string): Promise<boolean> {
    for (const h of this.handlers) {
      const result = await h.tryEvaluate(expression);
      if (result !== null) return result;
    }
    throw new Error(`no handler matched expression: ${expression}`);
  }

  async evaluateSustained(
    cond: DetectorCondition,
    opts: { timeoutMs: number; pollIntervalMs?: number },
  ): Promise<boolean> {
    const pollInterval = opts.pollIntervalMs ?? 2000;
    const sustainedMs = (cond.sustained_for_s ?? 0) * 1000;
    const deadline = Date.now() + opts.timeoutMs;

    let sustainedStart: number | null = null;

    while (Date.now() < deadline) {
      const ok = await this.evaluate(cond.expression);
      if (ok) {
        if (sustainedStart === null) sustainedStart = Date.now();
        if (Date.now() - sustainedStart >= sustainedMs) return true;
      } else {
        sustainedStart = null;
      }
      if (Date.now() + pollInterval > deadline) break;
      await sleep(pollInterval);
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
