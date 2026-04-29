import { execSync } from 'node:child_process';
import type { ClusterEvent } from '../types.js';
import { ingestEvent, newEventId } from './index.js';

let _pollInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Kubernetes watcher using kubectl polling.
 * In production, this should use the @kubernetes/client-node Watch API
 * for real-time streaming. For now, we poll periodically.
 */

function runKubectl(args: string): string {
  try {
    return execSync(`kubectl ${args}`, {
      encoding: 'utf-8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

/** Check for pods in error states */
async function checkPodHealth(): Promise<void> {
  const output = runKubectl('get pods --all-namespaces -o json');
  if (!output) return;

  try {
    const data = JSON.parse(output);
    for (const pod of data.items ?? []) {
      const name = pod.metadata?.name as string;
      const namespace = pod.metadata?.namespace as string;
      const phase = pod.status?.phase as string;

      // Check container statuses for restarts/errors
      for (const cs of pod.status?.containerStatuses ?? []) {
        const restartCount = cs.restartCount as number;
        const waiting = cs.state?.waiting;

        if (restartCount > 0 && cs.lastState?.terminated) {
          await ingestEvent({
            id: newEventId(),
            source: 'kubernetes',
            kind: 'pod_restart',
            summary: `Pod ${namespace}/${name} restarted (${restartCount} total)`,
            details: {
              podKey: `${namespace}/${name}`,
              namespace,
              pod: name,
              restartCount,
              reason: cs.lastState.terminated.reason,
            },
            timestamp: new Date(),
          });
        }

        if (waiting?.reason === 'CrashLoopBackOff') {
          await ingestEvent({
            id: newEventId(),
            source: 'kubernetes',
            kind: 'crash_loop',
            summary: `Pod ${namespace}/${name} is in CrashLoopBackOff`,
            details: { namespace, pod: name, restartCount },
            timestamp: new Date(),
          });
        }

        if (waiting?.reason === 'ImagePullBackOff' || waiting?.reason === 'ErrImagePull') {
          await ingestEvent({
            id: newEventId(),
            source: 'kubernetes',
            kind: 'image_pull_error',
            summary: `Pod ${namespace}/${name}: ${waiting.reason}`,
            details: { namespace, pod: name, reason: waiting.reason, message: waiting.message },
            timestamp: new Date(),
          });
        }
      }

      // Check for pending pods
      if (phase === 'Pending') {
        const conditions = pod.status?.conditions ?? [];
        const unschedulable = conditions.find(
          (c: Record<string, unknown>) => c.type === 'PodScheduled' && c.status === 'False',
        );
        if (unschedulable) {
          await ingestEvent({
            id: newEventId(),
            source: 'kubernetes',
            kind: 'pod_unschedulable',
            summary: `Pod ${namespace}/${name} cannot be scheduled: ${unschedulable.message}`,
            details: { namespace, pod: name, reason: unschedulable.reason },
            timestamp: new Date(),
          });
        }
      }
    }
  } catch {
    // JSON parse error or kubectl not available
  }
}

/** Check node conditions */
async function checkNodeHealth(): Promise<void> {
  const output = runKubectl('get nodes -o json');
  if (!output) return;

  try {
    const data = JSON.parse(output);
    for (const node of data.items ?? []) {
      const name = node.metadata?.name as string;
      const conditions = node.status?.conditions ?? [];

      for (const condition of conditions) {
        const type = condition.type as string;
        const status = condition.status as string;

        // Node NotReady
        if (type === 'Ready' && status !== 'True') {
          await ingestEvent({
            id: newEventId(),
            source: 'kubernetes',
            kind: 'node_not_ready',
            summary: `Node ${name} is NotReady: ${condition.message}`,
            details: { node: name, reason: condition.reason },
            timestamp: new Date(),
          });
        }

        // Pressure conditions
        if (['MemoryPressure', 'DiskPressure', 'PIDPressure'].includes(type) && status === 'True') {
          await ingestEvent({
            id: newEventId(),
            source: 'kubernetes',
            kind: 'node_pressure',
            summary: `Node ${name} has ${type}`,
            details: { node: name, condition: type, reason: condition.reason },
            timestamp: new Date(),
          });
        }
      }
    }
  } catch {
    // JSON parse error or kubectl not available
  }
}

/** Check recent Kubernetes events for warnings */
async function checkKubeEvents(): Promise<void> {
  const output = runKubectl('get events --all-namespaces --field-selector type=Warning -o json --sort-by=.lastTimestamp');
  if (!output) return;

  try {
    const data = JSON.parse(output);
    const now = Date.now();
    const fiveMinAgo = now - 5 * 60 * 1000;

    for (const event of (data.items ?? []).slice(-10)) {
      const lastTimestamp = new Date(event.lastTimestamp as string).getTime();
      if (lastTimestamp < fiveMinAgo) continue;

      await ingestEvent({
        id: newEventId(),
        source: 'kubernetes',
        kind: `kube_warning_${event.reason?.toLowerCase() ?? 'unknown'}`,
        summary: `[${event.involvedObject?.namespace ?? 'cluster'}/${event.involvedObject?.name ?? 'unknown'}] ${event.message}`,
        details: {
          namespace: event.involvedObject?.namespace,
          resource: event.involvedObject?.name,
          kind: event.involvedObject?.kind,
          reason: event.reason,
          count: event.count,
        },
        timestamp: new Date(event.lastTimestamp as string),
      });
    }
  } catch {
    // ignore
  }
}

/** Start the Kubernetes watcher with periodic polling */
export function startKubernetesWatcher(intervalMs = 60_000): void {
  // Run immediately once
  void runChecks();

  _pollInterval = setInterval(() => {
    void runChecks();
  }, intervalMs);
}

async function runChecks(): Promise<void> {
  await checkPodHealth();
  await checkNodeHealth();
  await checkKubeEvents();
}

export function stopKubernetesWatcher(): void {
  if (_pollInterval) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
}
