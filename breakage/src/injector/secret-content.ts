/**
 * secret-content injector. Patches specific keys of a Secret's
 * data field — set or delete individual keys without touching
 * others.
 *
 * Values in the scenario YAML are plain-text; the injector
 * base64-encodes before writing. An empty string deletes the key
 * (useful for `secret-missing-key` scenarios).
 *
 * Implementation: uses a JSON Patch directly against CoreV1's
 * patchNamespacedSecret endpoint. Server-side apply was
 * initially tempting but it interacts badly with field-manager
 * ownership — a PATCH apply that omits a key does NOT delete it
 * unless the field manager claims ownership. JSON Patch has
 * explicit remove/replace operations and sidesteps the whole
 * ownership question.
 *
 * Undo uses a `replace` on the full data map to restore the
 * pre-injection state verbatim.
 */

import * as k8s from '@kubernetes/client-node';
import type { ClusterClient } from '../speculative-exec/cluster-client.js';
import type { Scenario, SecretContentInjector } from '../types/index.js';
import type { InjectorRunner, Undo } from './types.js';

export class SecretContentInjectorRunner
  implements InjectorRunner<SecretContentInjector>
{
  readonly type = 'secret-content' as const;
  private readonly coreV1: k8s.CoreV1Api;
  private readonly appsV1: k8s.AppsV1Api;

  constructor(_client: ClusterClient) {
    const kc = new k8s.KubeConfig();
    const override = process.env.BREAKAGE_KUBECONFIG;
    if (override) kc.loadFromFile(override);
    else kc.loadFromDefault();
    this.coreV1 = kc.makeApiClient(k8s.CoreV1Api);
    this.appsV1 = kc.makeApiClient(k8s.AppsV1Api);
  }

  async inject(_scenario: Scenario, injector: SecretContentInjector): Promise<Undo> {
    const ns = injector.target.ns;
    const secretName = injector.target.secret ?? '';
    if (!secretName) {
      throw new Error(
        `secret-content injector requires target.secret (got ${JSON.stringify(injector.target)})`,
      );
    }

    // Snapshot pre-state for the undo path.
    const pre = await this.coreV1.readNamespacedSecret({ name: secretName, namespace: ns });
    const preData: Record<string, string> = { ...((pre.data as Record<string, string> | undefined) ?? {}) };

    // Build a JSON Patch that explicitly sets or removes each key.
    const ops: Array<{ op: 'add' | 'replace' | 'remove'; path: string; value?: string }> = [];
    for (const [key, plainValue] of Object.entries(injector.values)) {
      const path = `/data/${jsonPointerEscape(key)}`;
      if (plainValue === '') {
        if (key in preData) ops.push({ op: 'remove', path });
      } else {
        const b64 = Buffer.from(plainValue, 'utf8').toString('base64');
        if (key in preData) ops.push({ op: 'replace', path, value: b64 });
        else ops.push({ op: 'add', path, value: b64 });
      }
    }

    if (ops.length > 0) {
      console.log(`[secret-content] patching ${ns}/${secretName} with ${ops.length} ops: ${JSON.stringify(ops)}`);
      try {
        await this.coreV1.patchNamespacedSecret(
          { name: secretName, namespace: ns, body: ops as unknown as k8s.V1Secret },
          k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.JsonPatch),
        );
        console.log(`[secret-content] patch succeeded`);
      } catch (err) {
        console.error(`[secret-content] patch FAILED:`, err);
        throw err;
      }
    }

    // Rollout-restart dependent workloads so pods pick up the new env.
    const restartTargets = injector.restart_workloads ?? [];
    for (const rw of restartTargets) {
      await this.rolloutRestart(ns, rw.kind, rw.name);
    }

    return async () => {
      // Restore by replacing the entire data map with the pre-state.
      // Use a single JSON Patch replace op against /data so the
      // restoration is atomic.
      await this.coreV1.patchNamespacedSecret(
        {
          name: secretName,
          namespace: ns,
          body: [{ op: 'replace', path: '/data', value: preData }] as unknown as k8s.V1Secret,
        },
        k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.JsonPatch),
      );
      for (const rw of restartTargets) {
        await this.rolloutRestart(ns, rw.kind, rw.name).catch(() => { /* best-effort */ });
      }
    };
  }

  /**
   * Trigger a Deployment/StatefulSet rollout restart by patching
   * a `kubectl.kubernetes.io/restartedAt` annotation on the pod
   * template — same mechanism `kubectl rollout restart` uses.
   */
  private async rolloutRestart(ns: string, kind: 'Deployment' | 'StatefulSet', name: string): Promise<void> {
    const restartedAt = new Date().toISOString();
    const patch = [
      {
        op: 'add' as const,
        path: '/spec/template/metadata/annotations',
        value: {} as Record<string, string>,
      },
      {
        op: 'add' as const,
        path: '/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt',
        value: restartedAt,
      },
    ];
    // The first `add` may fail with "already exists" on a Deployment
    // that already has annotations — swallow and fall through to the
    // second op which sets the restartedAt key.
    try {
      if (kind === 'Deployment') {
        await this.appsV1.patchNamespacedDeployment(
          { name, namespace: ns, body: patch as unknown as k8s.V1Deployment },
          k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.JsonPatch),
        );
      } else {
        await this.appsV1.patchNamespacedStatefulSet(
          { name, namespace: ns, body: patch as unknown as k8s.V1StatefulSet },
          k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.JsonPatch),
        );
      }
    } catch {
      // The add-empty-map op failed → annotations already exist →
      // retry with just the set op.
      const justSet = [patch[1]];
      if (kind === 'Deployment') {
        await this.appsV1.patchNamespacedDeployment(
          { name, namespace: ns, body: justSet as unknown as k8s.V1Deployment },
          k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.JsonPatch),
        );
      } else {
        await this.appsV1.patchNamespacedStatefulSet(
          { name, namespace: ns, body: justSet as unknown as k8s.V1StatefulSet },
          k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.JsonPatch),
        );
      }
    }
  }
}

function jsonPointerEscape(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}
