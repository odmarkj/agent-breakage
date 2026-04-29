import { execSync } from 'node:child_process';
import { ingestEvent, newEventId } from './index.js';

/**
 * PVC disk usage monitoring.
 * Finds pods mounting each PVC, then runs df inside the pod to get actual usage.
 * Falls back to binding-status check if df isn't possible.
 */

/** Alert when PVC usage exceeds this percentage */
const USAGE_WARNING_PCT = 80;
const USAGE_CRITICAL_PCT = 90;

interface PvcInfo {
  name: string;
  namespace: string;
  volumeName: string;
  capacity: string;
  phase: string;
}

interface PvcUsage {
  pvc: string;
  namespace: string;
  pod: string;
  mountPath: string;
  usedBytes: number;
  totalBytes: number;
  usePct: number;
}

function runKubectl(args: string): string {
  try {
    return execSync(`kubectl ${args}`, {
      encoding: 'utf-8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

/** Get all PVCs in the cluster */
function getAllPVCs(): PvcInfo[] {
  const output = runKubectl('get pvc --all-namespaces -o json');
  if (!output) return [];

  try {
    const data = JSON.parse(output);
    return (data.items ?? []).map((pvc: Record<string, any>) => ({
      name: pvc.metadata?.name as string,
      namespace: pvc.metadata?.namespace as string,
      volumeName: pvc.spec?.volumeName as string,
      capacity: pvc.status?.capacity?.storage as string ?? 'unknown',
      phase: pvc.status?.phase as string,
    }));
  } catch {
    return [];
  }
}

/** Find a pod that mounts a given PVC and return pod name + mount path */
function findPodForPVC(namespace: string, pvcName: string): { pod: string; container: string; mountPath: string } | null {
  const output = runKubectl(`get pods -n ${namespace} -o json`);
  if (!output) return null;

  try {
    const data = JSON.parse(output);
    for (const pod of data.items ?? []) {
      const podName = pod.metadata?.name as string;
      const phase = pod.status?.phase as string;
      if (phase !== 'Running') continue;

      const volumes = pod.spec?.volumes ?? [];
      const pvcVolume = volumes.find(
        (v: Record<string, any>) => v.persistentVolumeClaim?.claimName === pvcName,
      );
      if (!pvcVolume) continue;

      // Find the container + mountPath for this volume
      for (const container of pod.spec?.containers ?? []) {
        for (const mount of container.volumeMounts ?? []) {
          if (mount.name === pvcVolume.name) {
            return { pod: podName, container: container.name, mountPath: mount.mountPath };
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/** Run df inside a pod to get disk usage for a mount path */
function getDiskUsage(namespace: string, pod: string, container: string, mountPath: string): { usedBytes: number; totalBytes: number; usePct: number } | null {
  // Use df with 1K blocks for consistent parsing
  const output = runKubectl(
    `exec -n ${namespace} ${pod} -c ${container} -- df -k ${mountPath}`,
  );
  if (!output) return null;

  try {
    // df output: Filesystem 1K-blocks Used Available Use% Mounted
    const lines = output.split('\n');
    if (lines.length < 2) return null;

    const parts = lines[1].trim().split(/\s+/);
    if (parts.length < 5) return null;

    const totalKb = parseInt(parts[1], 10);
    const usedKb = parseInt(parts[2], 10);
    const usePct = parseInt(parts[4].replace('%', ''), 10);

    return {
      usedBytes: usedKb * 1024,
      totalBytes: totalKb * 1024,
      usePct,
    };
  } catch {
    return null;
  }
}

/** Check all PVC disk usage across the cluster */
export async function checkPVCDiskUsage(): Promise<void> {
  const pvcs = getAllPVCs();

  for (const pvc of pvcs) {
    // First check binding status
    if (pvc.phase !== 'Bound') {
      await ingestEvent({
        id: newEventId(),
        source: 'schedule',
        kind: 'pvc_not_bound',
        summary: `PVC ${pvc.namespace}/${pvc.name} is ${pvc.phase}`,
        details: { namespace: pvc.namespace, pvc: pvc.name, phase: pvc.phase },
        timestamp: new Date(),
      });
      continue;
    }

    // Find a running pod that mounts this PVC
    const podInfo = findPodForPVC(pvc.namespace, pvc.name);
    if (!podInfo) continue; // No running pod with this PVC — can't check usage

    const usage = getDiskUsage(pvc.namespace, podInfo.pod, podInfo.container, podInfo.mountPath);
    if (!usage) continue;

    const severity = usage.usePct >= USAGE_CRITICAL_PCT ? 'critical' : usage.usePct >= USAGE_WARNING_PCT ? 'warning' : null;
    if (!severity) continue;

    const totalMb = Math.round(usage.totalBytes / 1024 / 1024);
    const usedMb = Math.round(usage.usedBytes / 1024 / 1024);

    await ingestEvent({
      id: newEventId(),
      source: 'schedule',
      kind: severity === 'critical' ? 'pvc_disk_critical' : 'pvc_disk_warning',
      summary: `PVC ${pvc.namespace}/${pvc.name} at ${usage.usePct}% (${usedMb}MB/${totalMb}MB)`,
      details: {
        namespace: pvc.namespace,
        pvc: pvc.name,
        pod: podInfo.pod,
        mountPath: podInfo.mountPath,
        usePct: usage.usePct,
        usedMb,
        totalMb,
        capacity: pvc.capacity,
        severity,
      },
      timestamp: new Date(),
    });
  }
}
