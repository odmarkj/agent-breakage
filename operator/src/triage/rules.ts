import type { ClusterEvent, TriageDecision } from '../types.js';

interface SuppressionState {
  lastSeen: Map<string, number>; // event fingerprint -> timestamp
  podRestarts: Map<string, number[]>; // pod key -> restart timestamps
}

const state: SuppressionState = {
  lastSeen: new Map(),
  podRestarts: new Map(),
};

const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const PVC_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours — disk usage changes slowly
const RESTART_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RESTART_THRESHOLD = 3;

/** Generate a fingerprint for deduplication */
function fingerprint(event: ClusterEvent): string {
  return `${event.source}:${event.kind}:${event.summary}`;
}

/**
 * Cheap heuristic rules that run before any LLM call.
 * Returns a decision if the rule matches, or null to pass through to the classifier.
 */
export function applyHeuristicRules(event: ClusterEvent): TriageDecision | null {
  const now = Date.now();
  const fp = fingerprint(event);

  // ── Deduplication / cooldown ────────────────────────────────────
  const lastTime = state.lastSeen.get(fp);
  if (lastTime && now - lastTime < COOLDOWN_MS) {
    return 'ignore';
  }
  state.lastSeen.set(fp, now);

  // ── Kubernetes-specific rules ───────────────────────────────────
  if (event.source === 'kubernetes') {
    // Pod restarts below threshold: suppress
    if (event.kind === 'pod_restart') {
      const podKey = event.details.podKey as string ?? event.summary;
      const restarts = state.podRestarts.get(podKey) ?? [];
      const recent = restarts.filter((t) => now - t < RESTART_WINDOW_MS);
      recent.push(now);
      state.podRestarts.set(podKey, recent);

      if (recent.length < RESTART_THRESHOLD) {
        return 'log'; // record but don't act
      }
      // Above threshold: pass through to classifier
      return null;
    }

    // Normal scheduling events: ignore
    if (event.kind === 'scheduled' || event.kind === 'pulled' || event.kind === 'created') {
      return 'ignore';
    }

    // Known false-positive node-level warnings
    if (event.kind.startsWith('kube_warning_')) {
      const involvedKind = event.details.kind as string | undefined;
      const reason = event.details.reason as string | undefined;

      if (involvedKind === 'Node' && reason === 'InvalidDiskCapacity') {
        return 'log'; // Record but don't create goals — k3s/containerd reports 0 capacity for image filesystem
      }
    }

    // Nameserver limits exceeded — benign cluster DNS config, cannot be fixed by operator
    if (event.summary.includes('Nameserver limits were exceeded')) {
      return 'ignore';
    }

    // Transient readiness/liveness probe failures — pods self-heal via restarts
    if (event.kind === 'kube_warning_unhealthy' && event.summary.includes('probe failed')) {
      return 'log';
    }
  }

  // ── Autoscaling alerts for non-production namespaces ────────────
  // PodCPUHigh/Low and PodMemoryHigh are autoscaling alerts. The autoscaler only
  // handles prod-* namespaces. For infra pods (monitoring, kube-system, platform),
  // these indicate normal fixed footprints — not actionable. Just log them.
  if (event.source === 'alertmanager') {
    const alertname = event.details?.alertname as string | undefined;
    if (alertname === 'PodMemoryHigh' || alertname === 'PodCPULow' || alertname === 'PodCPUHigh') {
      return 'log';
    }
  }

  // ── Autoscaler events (any source) ─────────────────────────────
  // These are already handled by the heuristic autoscaler; just log for the record
  if (event.kind === 'autoscale_action' || event.kind === 'autoscale_alert_handled') {
    return 'log';
  }

  // ── Schedule-sourced rules ──────────────────────────────────────
  if (event.source === 'schedule') {

    // PVC disk warnings: use stable fingerprint (namespace/pvc + pct bucket) with 4-hour cooldown.
    // The exact MB values fluctuate between scans, so the generic fingerprint doesn't dedup properly.
    if (event.kind === 'pvc_disk_warning' || event.kind === 'pvc_disk_critical') {
      const ns = event.details.namespace as string ?? 'unknown';
      const pvc = event.details.pvc as string ?? 'unknown';
      const pct = event.details.usePct as number ?? 0;
      // Bucket by 5% increments so minor fluctuations don't create new fingerprints
      const pctBucket = Math.floor(pct / 5) * 5;
      const stableFp = `pvc:${ns}/${pvc}:${pctBucket}pct`;

      const lastPvcTime = state.lastSeen.get(stableFp);
      if (lastPvcTime && now - lastPvcTime < PVC_COOLDOWN_MS) {
        return 'ignore';
      }
      state.lastSeen.set(stableFp, now);

      // Critical still passes through to classifier; warnings are just logged
      if (event.kind === 'pvc_disk_warning') {
        return 'log';
      }
    }
  }

  // ── GitHub-specific rules ───────────────────────────────────────
  if (event.source === 'github') {
    // Non-main branch pushes: ignore
    const branch = event.details.branch as string;
    if (branch && branch !== 'main' && branch !== 'master') {
      return 'ignore';
    }
  }

  // ── No heuristic match: pass to classifier ─────────────────────
  return null;
}

/** Periodically clean up stale state */
export function cleanupState(): void {
  const now = Date.now();
  const staleThreshold = 30 * 60 * 1000; // 30 minutes

  for (const [key, timestamp] of state.lastSeen) {
    if (now - timestamp > staleThreshold) {
      state.lastSeen.delete(key);
    }
  }

  for (const [key, timestamps] of state.podRestarts) {
    const recent = timestamps.filter((t) => now - t < RESTART_WINDOW_MS);
    if (recent.length === 0) {
      state.podRestarts.delete(key);
    } else {
      state.podRestarts.set(key, recent);
    }
  }
}
