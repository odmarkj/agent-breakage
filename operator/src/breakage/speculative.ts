/**
 * Speculative-execution wrapper for Emily's tier-2 mutating tools.
 *
 * When `SPECULATIVE_EXEC=enabled` is set in env, the agent loop
 * routes tier-2 tools with reversibility ≤ 0.3 through the
 * breakage SpeculativeController:
 *
 *   1. snapshot the target resource + associated ConfigMaps/Secrets
 *   2. run the tool normally
 *   3. watch readyReplicas for regression (Phase 1 minimal SLO probe)
 *   4. if readyReplicas drops more than a configured threshold, auto-revert
 *   5. emit a mechanical revert reason Emily includes in her postmortem
 *
 * N=2 attempt limit per target resource is handled by the
 * SpeculativeController itself: third attempt on the same resource
 * returns 'paused-for-approval' without running the mutation.
 *
 * This module no-ops gracefully when SPECULATIVE_EXEC isn't
 * enabled — passes through to the tool's normal execute().
 *
 * The `breakage/` sibling package and `@kubernetes/client-node` are
 * only loaded via dynamic import, so the operator can be built and
 * typechecked without them. When SPECULATIVE_EXEC is enabled at
 * runtime and either isn't resolvable, the wrapper falls through
 * to plain execute.
 */

import type { ToolDefinition } from '../types.js';

export interface SpecExecResult {
  /** The tool's own return value, or null if reverted before completion. */
  result: unknown;
  /** When auto-revert fired: mechanical reason string from the controller. */
  revertedMechanicalReason?: string;
  /** When N=2 attempt limit hit: reason string. */
  pausedForApproval?: string;
}

// ── Dynamic loading ─────────────────────────────────────────────────

type BreakageModule = {
  SpeculativeController: new (client: unknown) => {
    executeWithRevert: <T>(opts: {
      scenarioId: string | null;
      primary: { kind: string; namespace: string; name: string };
      run: () => Promise<T>;
      probes: Array<{
        name: string;
        threshold: number;
        captureBaseline: () => Promise<number>;
        currentValue: () => Promise<number>;
      }>;
      windowMs: number;
    }) => Promise<
      | { type: 'held'; result: T }
      | { type: 'reverted'; event: { mechanicalReason: string } }
      | { type: 'paused-for-approval'; reason: string }
    >;
  };
  makeK8sClusterClient: () => unknown;
};

type K8sModule = {
  KubeConfig: new () => {
    loadFromFile: (p: string) => void;
    loadFromDefault: () => void;
    makeApiClient: (api: unknown) => unknown;
  };
  AppsV1Api: unknown;
};

let _breakage: BreakageModule | null = null;
let _k8s: K8sModule | null = null;
let _controller: InstanceType<BreakageModule['SpeculativeController']> | null = null;

async function loadBreakage(): Promise<BreakageModule | null> {
  if (_breakage) return _breakage;
  try {
    const specMod = (await import(
      '../../../breakage/src/speculative-exec/index.js' as string
    )) as { SpeculativeController: BreakageModule['SpeculativeController'] };
    const clientMod = (await import(
      '../../../breakage/src/speculative-exec/k8s-client.js' as string
    )) as { makeK8sClusterClient: BreakageModule['makeK8sClusterClient'] };
    _breakage = {
      SpeculativeController: specMod.SpeculativeController,
      makeK8sClusterClient: clientMod.makeK8sClusterClient,
    };
    return _breakage;
  } catch {
    return null;
  }
}

async function loadK8s(): Promise<K8sModule | null> {
  if (_k8s) return _k8s;
  try {
    const mod = (await import('@kubernetes/client-node' as string)) as {
      KubeConfig: K8sModule['KubeConfig'];
      AppsV1Api: K8sModule['AppsV1Api'];
    };
    _k8s = { KubeConfig: mod.KubeConfig, AppsV1Api: mod.AppsV1Api };
    return _k8s;
  } catch {
    return null;
  }
}

async function getController() {
  if (_controller) return _controller;
  const mod = await loadBreakage();
  if (!mod) return null;
  const client = mod.makeK8sClusterClient();
  _controller = new mod.SpeculativeController(client);
  return _controller;
}

// ── Resource-ref derivation ─────────────────────────────────────────

export function resourceRefForTool(
  toolName: string,
  input: Record<string, unknown>,
): { kind: string; namespace: string; name: string } | null {
  const ns = (input.namespace ?? input.ns) as string | undefined;
  const name = input.name as string | undefined;
  const resource = (input.resource as string | undefined)?.toLowerCase();

  if (!ns || !name) return null;

  switch (toolName) {
    case 'kubectl_scale':
    case 'kubectl_rollout_restart':
    case 'kubectl_rollout_undo': {
      if (resource === 'deployment') return { kind: 'Deployment', namespace: ns, name };
      if (resource === 'statefulset') return { kind: 'StatefulSet', namespace: ns, name };
      return null;
    }
    default:
      return null;
  }
}

// ── Readiness probe ─────────────────────────────────────────────────

async function makeReadinessProbe(
  kind: string,
  ns: string,
  name: string,
): Promise<{
  name: string;
  threshold: number;
  captureBaseline: () => Promise<number>;
  currentValue: () => Promise<number>;
} | null> {
  const k8s = await loadK8s();
  if (!k8s) return null;

  const kc = new k8s.KubeConfig();
  const override = process.env.BREAKAGE_KUBECONFIG ?? process.env.KUBECONFIG;
  if (override) kc.loadFromFile(override);
  else kc.loadFromDefault();

  const appsV1 = kc.makeApiClient(k8s.AppsV1Api) as {
    readNamespacedDeployment: (args: { name: string; namespace: string }) => Promise<{ status?: { readyReplicas?: number } }>;
    readNamespacedStatefulSet: (args: { name: string; namespace: string }) => Promise<{ status?: { readyReplicas?: number } }>;
  };

  const readyOf = async (): Promise<number> => {
    try {
      if (kind === 'Deployment') {
        const d = await appsV1.readNamespacedDeployment({ name, namespace: ns });
        return d.status?.readyReplicas ?? 0;
      }
      if (kind === 'StatefulSet') {
        const s = await appsV1.readNamespacedStatefulSet({ name, namespace: ns });
        return s.status?.readyReplicas ?? 0;
      }
      return 0;
    } catch {
      return 0;
    }
  };

  let baseline = 0;

  return {
    name: `readyReplicas_drop{${kind}=${ns}/${name}}`,
    threshold: 0.5, // trip if more than half the ready pods disappear
    captureBaseline: async () => {
      baseline = await readyOf();
      return 0;
    },
    currentValue: async () => {
      if (baseline === 0) return 0;
      const now = await readyOf();
      return Math.max(0, (baseline - now) / baseline);
    },
  };
}

// ── Public API ──────────────────────────────────────────────────────

const ENABLED = () => process.env.SPECULATIVE_EXEC === 'enabled';
const WATCH_WINDOW_MS = Number(process.env.SPECULATIVE_EXEC_WINDOW_MS ?? 30_000);

export async function executeTierTwoWithSpecExec(
  tool: ToolDefinition,
  input: Record<string, unknown>,
): Promise<SpecExecResult> {
  if (!ENABLED()) {
    return { result: await tool.execute(input) };
  }
  if (tool.reversibility > 0.3) {
    return { result: await tool.execute(input) };
  }
  const ref = resourceRefForTool(tool.name, input);
  if (!ref) {
    return { result: await tool.execute(input) };
  }

  const controller = await getController();
  if (!controller) {
    console.warn('[spec-exec] enabled but breakage/ module not resolvable — falling through');
    return { result: await tool.execute(input) };
  }

  const probe = await makeReadinessProbe(ref.kind, ref.namespace, ref.name);
  if (!probe) {
    console.warn('[spec-exec] @kubernetes/client-node unavailable for probe — falling through');
    return { result: await tool.execute(input) };
  }

  const outcome = await controller.executeWithRevert({
    scenarioId: process.env.BREAKAGE_SCENARIO_ID ?? null,
    primary: ref,
    run: () => tool.execute(input),
    probes: [probe],
    windowMs: WATCH_WINDOW_MS,
  });

  if (outcome.type === 'held') {
    return { result: outcome.result };
  }
  if (outcome.type === 'reverted') {
    return {
      result: null,
      revertedMechanicalReason: outcome.event.mechanicalReason,
    };
  }
  return {
    result: null,
    pausedForApproval: outcome.reason,
  };
}

export async function isSpeculativeExecActive(): Promise<boolean> {
  if (!ENABLED()) return false;
  return (await loadBreakage()) !== null;
}
