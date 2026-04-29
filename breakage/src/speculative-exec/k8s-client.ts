/**
 * ClusterClient backed by @kubernetes/client-node.
 *
 * Read-and-apply implementation suitable for Phase-1 Week-1 scope
 * (single-resource mutations). Multi-resource edge cases — Helm,
 * operator-reconciled resources — are handled by keeping those ops
 * at tier-3 and outside the speculative-exec envelope in Week 1.
 */

import * as k8s from '@kubernetes/client-node';
import type { ClusterClient } from './cluster-client.js';
import type { ResourceKind, ResourceRef } from './types.js';

/**
 * Create a ClusterClient from a kubeconfig. Uses
 * BREAKAGE_KUBECONFIG if set, otherwise the default
 * KUBECONFIG resolution (same as kubectl).
 */
export function makeK8sClusterClient(): ClusterClient {
  const kc = new k8s.KubeConfig();
  const override = process.env.BREAKAGE_KUBECONFIG;
  if (override) {
    kc.loadFromFile(override);
  } else {
    kc.loadFromDefault();
  }
  return new K8sClusterClient(kc);
}

class K8sClusterClient implements ClusterClient {
  private readonly coreV1: k8s.CoreV1Api;
  private readonly appsV1: k8s.AppsV1Api;
  private readonly autoscalingV2: k8s.AutoscalingV2Api;
  private readonly policyV1: k8s.PolicyV1Api;
  private readonly objectApi: k8s.KubernetesObjectApi;

  constructor(kc: k8s.KubeConfig) {
    this.coreV1 = kc.makeApiClient(k8s.CoreV1Api);
    this.appsV1 = kc.makeApiClient(k8s.AppsV1Api);
    this.autoscalingV2 = kc.makeApiClient(k8s.AutoscalingV2Api);
    this.policyV1 = kc.makeApiClient(k8s.PolicyV1Api);
    this.objectApi = k8s.KubernetesObjectApi.makeApiClient(kc);
  }

  async get(ref: ResourceRef): Promise<Record<string, unknown>> {
    // KubernetesObjectHeader shape — apiVersion, kind, metadata{name,namespace?}.
    // Not exported as a public symbol, inline the structural type.
    const header = {
      apiVersion: apiVersionFor(ref.kind),
      kind: ref.kind,
      metadata: { namespace: ref.namespace, name: ref.name },
    };
    const res = await this.objectApi.read(header as unknown as k8s.KubernetesObject & { metadata: { name: string } });
    return normalizeForReApply(res as unknown as Record<string, unknown>);
  }

  async apply(ref: ResourceRef, manifest: Record<string, unknown>): Promise<void> {
    const payload: k8s.KubernetesObject = {
      ...manifest,
      apiVersion: apiVersionFor(ref.kind),
      kind: ref.kind,
      metadata: {
        ...((manifest.metadata as Record<string, unknown> | undefined) ?? {}),
        namespace: ref.namespace,
        name: ref.name,
      },
    };
    // Server-side apply with force=true — overrides foreign field
    // managers, which is what we want for revert (we're claiming
    // ownership of the fields we snapshotted).
    await this.objectApi.patch(
      payload,
      undefined,
      undefined,
      'breakage-speculative-exec',
      true,
      k8s.PatchStrategy.ServerSideApply,
    );
  }

  async findAssociated(primary: ResourceRef): Promise<ResourceRef[]> {
    if (primary.kind !== 'Deployment' && primary.kind !== 'StatefulSet') {
      // For non-workload resources, the "associated" set is empty —
      // revert only the primary.
      return [];
    }

    const associated: ResourceRef[] = [];

    // ConfigMap and Secret references from the workload's pod spec.
    const manifest = await this.get(primary);
    const spec = (manifest as { spec?: { template?: { spec?: unknown } } }).spec;
    const podSpec = spec?.template?.spec as { volumes?: unknown[]; containers?: unknown[] } | undefined;
    if (podSpec) {
      const refs = extractConfigRefs(podSpec, primary.namespace);
      associated.push(...refs);
    }

    // HPAs in the namespace that target this workload.
    try {
      const hpas = await this.autoscalingV2.listNamespacedHorizontalPodAutoscaler({ namespace: primary.namespace });
      for (const hpa of hpas.items ?? []) {
        const ref = hpa.spec?.scaleTargetRef;
        if (ref && ref.kind === primary.kind && ref.name === primary.name) {
          associated.push({
            kind: 'HorizontalPodAutoscaler',
            namespace: primary.namespace,
            name: hpa.metadata?.name ?? '',
          });
        }
      }
    } catch {
      // HPA API unreachable or RBAC disallowed; skip this edge.
    }

    // PDBs in the namespace that likely select this workload.
    try {
      const pdbs = await this.policyV1.listNamespacedPodDisruptionBudget({ namespace: primary.namespace });
      const workloadLabels = await this.workloadSelectorLabels(primary);
      if (workloadLabels) {
        for (const pdb of pdbs.items ?? []) {
          const sel = pdb.spec?.selector?.matchLabels;
          if (sel && labelsMatch(sel, workloadLabels)) {
            associated.push({
              kind: 'PodDisruptionBudget',
              namespace: primary.namespace,
              name: pdb.metadata?.name ?? '',
            });
          }
        }
      }
    } catch {
      // skip
    }

    return associated;
  }

  private async workloadSelectorLabels(ref: ResourceRef): Promise<Record<string, string> | null> {
    try {
      if (ref.kind === 'Deployment') {
        const d = await this.appsV1.readNamespacedDeployment({ name: ref.name, namespace: ref.namespace });
        return (d.spec?.selector?.matchLabels as Record<string, string> | undefined) ?? null;
      }
      if (ref.kind === 'StatefulSet') {
        const s = await this.appsV1.readNamespacedStatefulSet({ name: ref.name, namespace: ref.namespace });
        return (s.spec?.selector?.matchLabels as Record<string, string> | undefined) ?? null;
      }
    } catch {
      return null;
    }
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function apiVersionFor(kind: ResourceKind): string {
  switch (kind) {
    case 'Deployment':
    case 'StatefulSet':
      return 'apps/v1';
    case 'ConfigMap':
    case 'Secret':
    case 'Service':
      return 'v1';
    case 'HorizontalPodAutoscaler':
      return 'autoscaling/v2';
    case 'PodDisruptionBudget':
      return 'policy/v1';
  }
}

/**
 * Strip server-side-managed fields so the manifest can be re-applied
 * cleanly. Mirrors the transformations `kubectl get -o yaml` makes
 * when preparing output for editing.
 */
function normalizeForReApply(obj: Record<string, unknown>): Record<string, unknown> {
  const m = (obj.metadata as Record<string, unknown> | undefined) ?? {};
  const cleaned = { ...obj };
  cleaned.metadata = {
    ...m,
    resourceVersion: undefined,
    uid: undefined,
    creationTimestamp: undefined,
    generation: undefined,
    managedFields: undefined,
    selfLink: undefined,
  };
  delete (cleaned as { status?: unknown }).status;
  return cleaned;
}

function extractConfigRefs(
  podSpec: { volumes?: unknown[]; containers?: unknown[] },
  ns: string,
): ResourceRef[] {
  const refs: ResourceRef[] = [];
  const seen = new Set<string>();
  const push = (kind: 'ConfigMap' | 'Secret', name: string) => {
    const key = `${kind}/${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ kind, namespace: ns, name });
  };

  // Volumes
  for (const v of podSpec.volumes ?? []) {
    const vol = v as Record<string, unknown>;
    const cm = vol.configMap as { name?: string } | undefined;
    if (cm?.name) push('ConfigMap', cm.name);
    const sec = vol.secret as { secretName?: string } | undefined;
    if (sec?.secretName) push('Secret', sec.secretName);
  }

  // Containers env + envFrom
  for (const c of podSpec.containers ?? []) {
    const container = c as {
      env?: Array<{ valueFrom?: { configMapKeyRef?: { name?: string }; secretKeyRef?: { name?: string } } }>;
      envFrom?: Array<{ configMapRef?: { name?: string }; secretRef?: { name?: string } }>;
    };
    for (const e of container.env ?? []) {
      if (e.valueFrom?.configMapKeyRef?.name) push('ConfigMap', e.valueFrom.configMapKeyRef.name);
      if (e.valueFrom?.secretKeyRef?.name) push('Secret', e.valueFrom.secretKeyRef.name);
    }
    for (const e of container.envFrom ?? []) {
      if (e.configMapRef?.name) push('ConfigMap', e.configMapRef.name);
      if (e.secretRef?.name) push('Secret', e.secretRef.name);
    }
  }

  return refs;
}

function labelsMatch(selector: Record<string, string>, target: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(selector)) {
    if (target[k] !== v) return false;
  }
  return true;
}
