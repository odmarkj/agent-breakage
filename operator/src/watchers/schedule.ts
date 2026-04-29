import { execSync } from 'node:child_process';
import type { ClusterEvent } from '../types.js';
import { ingestEvent, newEventId } from './index.js';
import { checkPostgresHealth } from './postgres.js';
import { checkPVCDiskUsage } from './pvc-usage.js';
import { checkEndpointUptime } from './uptimerobot.js';

/**
 * Scheduled checks that run on intervals.
 * These generate synthetic events that feed into the triage pipeline.
 */

interface ScheduledCheck {
  name: string;
  intervalMs: number;
  fn: () => Promise<void>;
  timer?: ReturnType<typeof setInterval>;
}

const checks: ScheduledCheck[] = [
  {
    name: 'cluster_health',
    intervalMs: 5 * 60 * 1000, // 5 min
    fn: checkClusterHealth,
  },
  // resource_utilization removed — Prometheus now handles node CPU/memory alerting
  // via NodeCPUHigh/NodeMemoryHigh alert rules with proper sustained-duration evaluation
  {
    name: 'pvc_capacity',
    intervalMs: 30 * 60 * 1000, // 30 min
    fn: checkPVCCapacity,
  },
  {
    name: 'pvc_disk_usage',
    intervalMs: 15 * 60 * 1000, // 15 min
    fn: checkPVCDiskUsage,
  },
  {
    name: 'cert_expiry',
    intervalMs: 24 * 60 * 60 * 1000, // daily
    fn: checkCertExpiry,
  },
  {
    name: 'postgres_health',
    intervalMs: 5 * 60 * 1000, // 5 min
    fn: checkPostgresHealth,
  },
  {
    name: 'endpoint_uptime',
    intervalMs: 10 * 60 * 1000, // 10 min
    fn: checkEndpointUptime,
  },
];

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

async function checkClusterHealth(): Promise<void> {
  const nodesOutput = runKubectl('get nodes -o json');
  if (!nodesOutput) return;

  try {
    const data = JSON.parse(nodesOutput);
    const nodes = data.items ?? [];
    const notReady = nodes.filter((n: Record<string, unknown>) => {
      const conditions = (n.status as Record<string, unknown>)?.conditions as Array<Record<string, unknown>> ?? [];
      return !conditions.some((c) => c.type === 'Ready' && c.status === 'True');
    });

    if (notReady.length > 0) {
      await ingestEvent({
        id: newEventId(),
        source: 'schedule',
        kind: 'health_check_failed',
        summary: `${notReady.length}/${nodes.length} nodes not ready`,
        details: {
          totalNodes: nodes.length,
          notReadyNodes: notReady.map((n: Record<string, unknown>) => (n.metadata as Record<string, unknown>)?.name),
        },
        timestamp: new Date(),
      });
    }
  } catch {
    // ignore
  }
}

async function checkResourceUtilization(): Promise<void> {
  const output = runKubectl('top nodes --no-headers');
  if (!output) return;

  // Parse lines like: "node1   500m   25%   1024Mi   50%"
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;

    const nodeName = parts[0];
    const cpuPercent = parseInt(parts[2]?.replace('%', '') ?? '0', 10);
    const memPercent = parseInt(parts[4]?.replace('%', '') ?? '0', 10);

    if (cpuPercent > 85 || memPercent > 85) {
      await ingestEvent({
        id: newEventId(),
        source: 'schedule',
        kind: 'high_utilization',
        summary: `Node ${nodeName}: CPU ${cpuPercent}%, Memory ${memPercent}%`,
        details: { node: nodeName, cpuPercent, memPercent },
        timestamp: new Date(),
      });
    }
  }
}

async function checkPVCCapacity(): Promise<void> {
  const output = runKubectl('get pvc --all-namespaces -o json');
  if (!output) return;

  try {
    const data = JSON.parse(output);
    for (const pvc of data.items ?? []) {
      const name = pvc.metadata?.name as string;
      const namespace = pvc.metadata?.namespace as string;
      const phase = pvc.status?.phase as string;

      if (phase !== 'Bound') {
        await ingestEvent({
          id: newEventId(),
          source: 'schedule',
          kind: 'pvc_not_bound',
          summary: `PVC ${namespace}/${name} is ${phase}`,
          details: { namespace, pvc: name, phase },
          timestamp: new Date(),
        });
      }
    }
  } catch {
    // ignore
  }
}

async function checkCertExpiry(): Promise<void> {
  const output = runKubectl('get certificates --all-namespaces -o json');
  if (!output) return;

  try {
    const data = JSON.parse(output);
    const thirtyDaysFromNow = Date.now() + 30 * 24 * 60 * 60 * 1000;

    for (const cert of data.items ?? []) {
      const name = cert.metadata?.name as string;
      const namespace = cert.metadata?.namespace as string;
      const notAfter = cert.status?.notAfter as string;

      if (notAfter && new Date(notAfter).getTime() < thirtyDaysFromNow) {
        await ingestEvent({
          id: newEventId(),
          source: 'schedule',
          kind: 'cert_expiring',
          summary: `Certificate ${namespace}/${name} expires ${notAfter}`,
          details: { namespace, certificate: name, notAfter },
          timestamp: new Date(),
        });
      }
    }
  } catch {
    // cert-manager not installed or no certificates
  }
}

/** Start all scheduled checks */
export function startScheduledChecks(): void {
  for (const check of checks) {
    // Run once immediately
    void check.fn().catch(() => {});
    // Then on interval
    check.timer = setInterval(() => {
      void check.fn().catch(() => {});
    }, check.intervalMs);
  }
}

export function stopScheduledChecks(): void {
  for (const check of checks) {
    if (check.timer) {
      clearInterval(check.timer);
      check.timer = undefined;
    }
  }
}
