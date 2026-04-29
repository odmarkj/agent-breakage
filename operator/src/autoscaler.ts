import { execSync } from 'node:child_process';
import { logToolExecution } from './audit.js';
import { sendSlackMessage } from './watchers/slack.js';

/**
 * Event-driven heuristic autoscaler.
 *
 * Reacts to Prometheus AlertManager webhook alerts — no polling, no LLM.
 * Prometheus evaluates sustained thresholds (e.g. "CPU > 75% for 6m") and
 * fires alerts to AlertManager, which webhooks to the operator. This module
 * handles the "no-brainer" scaling actions:
 *
 * - PodCPUHigh (action: scale_up)   → +1 replica
 * - PodMemoryHigh (action: scale_up) → +1 replica
 * - PodCPULow (action: scale_down)  → -1 replica
 *
 * Guardrails:
 * - Only prod-* namespaces (platform/operator/kube-system excluded)
 * - Only Deployments (StatefulSets need human judgment)
 * - Bounds: 1–10 replicas
 * - 10-minute cooldown per deployment after any scale action
 * - All actions are audit-logged and posted to Slack
 *
 * Non-scaling alerts (node health, Redis, Postgres, PVC, crash loops) pass
 * through to the normal triage pipeline for the LLM agent to handle.
 */

// ── Configuration ────────────────────────────────────────────────────

const MIN_REPLICAS = 1;
const MAX_REPLICAS = 10;
const COOLDOWN_MS = 10 * 60 * 1000; // 10 min after a scale event
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ALERTS ?? '#k3s';

/** Alert names that trigger autoscaling actions.
 * Only CPU-based alerts trigger scaling — CPU correlates with request load.
 * Memory alerts are excluded because high per-pod memory usually indicates a
 * fixed footprint (e.g. ML models loaded at startup), not overload. Scaling
 * up just doubles the memory cost without helping. Memory alerts are routed
 * to the LLM triage pipeline instead for case-by-case investigation.
 */
const SCALE_UP_ALERTS = new Set(['PodCPUHigh']);
const SCALE_DOWN_ALERTS = new Set(['PodCPULow']);

// ── Cooldown tracking ────────────────────────────────────────────────

/** Key: "namespace/deployment" → timestamp of last scale action */
const lastScaleAt = new Map<string, number>();

// ── Kubectl helpers ──────────────────────────────────────────────────

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

/**
 * Get current replica count for a deployment.
 * Returns null if the deployment doesn't exist or isn't in a prod namespace.
 */
function getDeploymentReplicas(namespace: string, deployment: string): number | null {
  const output = runKubectl(
    `get deployment ${deployment} -n ${namespace} -o jsonpath='{.spec.replicas}'`,
  );
  if (!output) return null;
  const replicas = parseInt(output.replace(/'/g, ''), 10);
  return isNaN(replicas) ? null : replicas;
}

/**
 * Derive the deployment name from a pod name.
 * Pod names follow the pattern: deployment-name-replicaset-hash-pod-hash
 * We strip the last two segments (replicaset hash + pod hash).
 */
function podToDeployment(podName: string): string {
  const parts = podName.split('-');
  if (parts.length > 2) {
    return parts.slice(0, -2).join('-');
  }
  return podName;
}

// ── Alert handler ────────────────────────────────────────────────────

export interface AutoscaleAlert {
  alertname: string;
  namespace?: string;
  pod?: string;
  severity?: string;
  action?: string;
  summary?: string;
  description?: string;
}

/**
 * Handle an incoming AlertManager alert.
 * Returns true if the alert was handled by the autoscaler (scaling action taken
 * or intentionally skipped due to cooldown/bounds), false if it should be passed
 * to the normal triage pipeline.
 */
export async function handleAutoscaleAlert(alert: AutoscaleAlert): Promise<boolean> {
  const { alertname, namespace, pod } = alert;

  // Only handle known autoscaling alerts
  const isScaleUp = SCALE_UP_ALERTS.has(alertname);
  const isScaleDown = SCALE_DOWN_ALERTS.has(alertname);
  if (!isScaleUp && !isScaleDown) return false;

  // Only act on prod namespaces
  if (!namespace || !namespace.startsWith('prod-')) return false;

  // Derive deployment from pod name
  if (!pod) return false;
  const deployment = podToDeployment(pod);
  const key = `${namespace}/${deployment}`;

  // Check cooldown
  const now = Date.now();
  const lastScale = lastScaleAt.get(key) ?? 0;
  if (now - lastScale < COOLDOWN_MS) {
    return true; // handled (intentionally skipped, still in cooldown)
  }

  // Get current replica count
  const currentReplicas = getDeploymentReplicas(namespace, deployment);
  if (currentReplicas === null) return false; // deployment doesn't exist

  // Determine new replica count
  let newReplicas: number;
  let direction: 'up' | 'down';

  if (isScaleUp) {
    if (currentReplicas >= MAX_REPLICAS) return true; // at max, nothing to do
    newReplicas = currentReplicas + 1;
    direction = 'up';
  } else {
    if (currentReplicas <= MIN_REPLICAS) return true; // at min, nothing to do
    newReplicas = currentReplicas - 1;
    direction = 'down';
  }

  // Execute scale
  const reason = alert.summary ?? `${alertname}: ${alert.description ?? 'threshold exceeded'}`;
  const result = runKubectl(
    `scale deployment/${deployment} -n ${namespace} --replicas=${newReplicas}`,
  );

  // Record cooldown
  lastScaleAt.set(key, now);

  // Audit log
  await logToolExecution({
    userId: 'autoscaler-heuristic',
    toolName: 'kubectl_scale',
    toolInput: {
      resource: 'deployment',
      name: deployment,
      namespace,
      replicas: newReplicas,
      previousReplicas: currentReplicas,
      trigger: alertname,
      reason,
    },
    toolTier: 2,
    result: result || `Scaled ${key} ${currentReplicas} -> ${newReplicas}`,
  });

  // Notify Slack
  const emoji = direction === 'up' ? 'arrow_up' : 'arrow_down';
  await sendSlackMessage({
    channel: SLACK_CHANNEL,
    text: `:${emoji}: *Autoscale ${direction}* \`${key}\`: ${currentReplicas} -> ${newReplicas} replicas\n${reason}`,
  });

  return true;
}
