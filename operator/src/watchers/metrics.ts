import type { ClusterEvent } from '../types.js';
import { ingestEvent, newEventId } from './index.js';
import { handleAutoscaleAlert } from '../autoscaler.js';

/**
 * AlertManager webhook handler.
 * Parses Prometheus AlertManager webhook payloads into cluster events.
 * Autoscaling alerts (PodCPUHigh, PodMemoryHigh, PodCPULow) are handled
 * directly by the heuristic autoscaler — no LLM involved.
 * All other alerts feed into the normal triage pipeline.
 */

interface AlertManagerPayload {
  status: string;
  alerts: AlertManagerAlert[];
}

interface AlertManagerAlert {
  status: 'firing' | 'resolved';
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorURL: string;
}

export async function handleAlertManagerWebhook(
  payload: AlertManagerPayload,
): Promise<void> {
  for (const alert of payload.alerts ?? []) {
    if (alert.status === 'resolved') {
      // Log resolved alerts but don't triage
      await ingestEvent({
        id: newEventId(),
        source: 'alertmanager',
        kind: 'alert_resolved',
        summary: `[Resolved] ${alert.labels.alertname}: ${alert.annotations.summary ?? alert.annotations.description ?? ''}`,
        details: {
          alertname: alert.labels.alertname,
          severity: alert.labels.severity,
          namespace: alert.labels.namespace,
          pod: alert.labels.pod,
          labels: alert.labels,
          annotations: alert.annotations,
        },
        timestamp: new Date(alert.endsAt),
      });
      continue;
    }

    // Try heuristic autoscaler first — handles no-brainer scaling without LLM
    const handled = await handleAutoscaleAlert({
      alertname: alert.labels.alertname,
      namespace: alert.labels.namespace,
      pod: alert.labels.pod,
      severity: alert.labels.severity,
      action: alert.labels.action,
      summary: alert.annotations.summary,
      description: alert.annotations.description,
    });

    if (handled) {
      // Autoscaler took care of it — log for record-keeping but skip triage
      await ingestEvent({
        id: newEventId(),
        source: 'alertmanager',
        kind: 'autoscale_alert_handled',
        summary: `[AUTOSCALED] ${alert.labels.alertname}: ${alert.annotations.summary ?? ''}`,
        details: {
          alertname: alert.labels.alertname,
          namespace: alert.labels.namespace,
          pod: alert.labels.pod,
          action: alert.labels.action,
          labels: alert.labels,
          annotations: alert.annotations,
        },
        timestamp: new Date(alert.startsAt),
      });
      continue;
    }

    // Not an autoscale alert — feed into normal triage pipeline for LLM
    const severity = alert.labels.severity ?? 'warning';
    await ingestEvent({
      id: newEventId(),
      source: 'alertmanager',
      kind: `alert_${severity}`,
      summary: `[${severity.toUpperCase()}] ${alert.labels.alertname}: ${alert.annotations.summary ?? alert.annotations.description ?? ''}`,
      details: {
        alertname: alert.labels.alertname,
        severity,
        namespace: alert.labels.namespace,
        pod: alert.labels.pod,
        node: alert.labels.node,
        labels: alert.labels,
        annotations: alert.annotations,
        startsAt: alert.startsAt,
        generatorURL: alert.generatorURL,
      },
      timestamp: new Date(alert.startsAt),
    });
  }
}
