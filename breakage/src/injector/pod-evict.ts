/**
 * pod-evict injector. Deletes a configurable percentage of the
 * pods owned by a Deployment or StatefulSet.
 *
 * Models: flaky network partition killing replicas, node failure,
 * chaos-kill for availability testing.
 *
 * Semantics: we use `DELETE` on the Pod objects (equivalent to
 * `kubectl delete pod`). The owning ReplicaSet/StatefulSet
 * re-creates the evicted pods, so "undo" is a no-op — Kubernetes
 * handles recovery automatically.
 *
 * Runtime behavior depends on the target's replicas count. If
 * percentage=100, all pods are evicted simultaneously and the
 * service is briefly unavailable until recreation completes.
 */

import * as k8s from '@kubernetes/client-node';
import type { ClusterClient } from '../speculative-exec/cluster-client.js';
import type { PodEvictInjector, Scenario } from '../types/index.js';
import type { InjectorRunner, Undo } from './types.js';

export class PodEvictInjectorRunner implements InjectorRunner<PodEvictInjector> {
  readonly type = 'pod-evict' as const;
  private readonly coreV1: k8s.CoreV1Api;
  private readonly appsV1: k8s.AppsV1Api;

  constructor(_client: ClusterClient) {
    // pod-evict needs CoreV1 direct access (ClusterClient abstracts
    // get/apply but not list/delete). Keep our own client.
    const kc = new k8s.KubeConfig();
    const override = process.env.BREAKAGE_KUBECONFIG;
    if (override) kc.loadFromFile(override);
    else kc.loadFromDefault();
    this.coreV1 = kc.makeApiClient(k8s.CoreV1Api);
    this.appsV1 = kc.makeApiClient(k8s.AppsV1Api);
  }

  async inject(_scenario: Scenario, injector: PodEvictInjector): Promise<Undo> {
    const pct = Math.max(0, Math.min(100, injector.percentage));
    if (pct === 0) return async () => { /* no-op */ };

    // Resolve label selector from the workload target.
    const labelSelector = await this.resolveSelector(injector.target);
    if (!labelSelector) {
      throw new Error(
        `pod-evict: could not resolve label selector from target ${JSON.stringify(injector.target)}`,
      );
    }

    const pods = await this.coreV1.listNamespacedPod({
      namespace: injector.target.ns,
      labelSelector,
    });
    const items = pods.items ?? [];
    if (items.length === 0) {
      throw new Error(
        `pod-evict: no pods matched selector "${labelSelector}" in ns ${injector.target.ns}`,
      );
    }

    const toEvict = Math.max(1, Math.floor((items.length * pct) / 100));
    const victims = items.slice(0, toEvict);

    await Promise.all(
      victims.map(async (p) => {
        const name = p.metadata?.name;
        if (!name) return;
        try {
          await this.coreV1.deleteNamespacedPod({ name, namespace: injector.target.ns });
        } catch (err) {
          console.warn(`[pod-evict] delete ${name} failed: ${(err as Error).message}`);
        }
      }),
    );

    // Undo is a no-op: Kubernetes re-creates the pods via the
    // owning ReplicaSet/StatefulSet controller. The scenario's
    // detector is what observes whether recreation restores ready.
    return async () => { /* controller restores automatically */ };
  }

  private async resolveSelector(target: {
    ns: string;
    deploy?: string;
    sts?: string;
    [k: string]: string | undefined;
  }): Promise<string | null> {
    try {
      if (target.deploy) {
        const d = await this.appsV1.readNamespacedDeployment({
          name: target.deploy,
          namespace: target.ns,
        });
        return labelsToSelector(d.spec?.selector?.matchLabels ?? null);
      }
      if (target.sts) {
        const s = await this.appsV1.readNamespacedStatefulSet({
          name: target.sts,
          namespace: target.ns,
        });
        return labelsToSelector(s.spec?.selector?.matchLabels ?? null);
      }
    } catch (err) {
      console.warn(`[pod-evict] resolveSelector failed: ${(err as Error).message}`);
    }
    return null;
  }
}

function labelsToSelector(labels: Record<string, string> | null): string | null {
  if (!labels || Object.keys(labels).length === 0) return null;
  return Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',');
}
