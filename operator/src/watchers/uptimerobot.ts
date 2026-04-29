import { ingestEvent, newEventId } from './index.js';

/**
 * UptimeRobot integration.
 *
 * Two modes:
 * 1. Webhook receiver — UptimeRobot pushes status changes to POST /webhook/uptimerobot
 *    (real-time, works even if we miss a poll cycle)
 * 2. API poller — we pull monitor status periodically to calculate uptime
 *    and catch anything the webhook missed
 *
 * Config via environment:
 *   UPTIMEROBOT_API_KEY  — read-only API key (from UptimeRobot dashboard → Integrations & API)
 *   UPTIMEROBOT_WEBHOOK_SECRET — optional shared secret to validate inbound webhooks
 */

const API_BASE = 'https://api.uptimerobot.com/v2';

/** Monitor status codes from UptimeRobot API */
const STATUS_MAP: Record<number, string> = {
  0: 'paused',
  1: 'not_checked_yet',
  2: 'up',
  8: 'seems_down',
  9: 'down',
};

interface UptimeRobotMonitor {
  id: number;
  friendly_name: string;
  url: string;
  status: number;
  all_time_uptime_ratio: string;
  custom_uptime_ratio: string; // 7d,30d
  average_response_time: string;
  /** Only present if response_times=1 */
  response_times?: Array<{ value: number; datetime: number }>;
}

interface GetMonitorsResponse {
  stat: 'ok' | 'fail';
  monitors?: UptimeRobotMonitor[];
  error?: { message: string };
}

// ── Webhook handler ────────────────────────────────────────────────

export interface UptimeRobotWebhookPayload {
  /** Monitor friendly name */
  monitorFriendlyName?: string;
  monitorURL?: string;
  /** 2=up, 9=down, 8=seems_down */
  alertType?: string;
  alertTypeFriendlyName?: string;
  alertDetails?: string;
  alertDuration?: string;
  /** Optional secret for verification */
  secret?: string;
}

export async function handleUptimeRobotWebhook(
  payload: UptimeRobotWebhookPayload,
): Promise<void> {
  // Verify shared secret if configured
  const expectedSecret = process.env.UPTIMEROBOT_WEBHOOK_SECRET;
  if (expectedSecret && payload.secret !== expectedSecret) {
    return; // silently drop invalid webhooks
  }

  const alertType = parseInt(payload.alertType ?? '0', 10);
  const isDown = alertType === 8 || alertType === 9;
  const isUp = alertType === 2;

  if (isDown) {
    await ingestEvent({
      id: newEventId(),
      source: 'schedule',
      kind: 'endpoint_down',
      summary: `Endpoint DOWN: ${payload.monitorFriendlyName} (${payload.monitorURL})`,
      details: {
        monitor: payload.monitorFriendlyName,
        url: payload.monitorURL,
        alertType: payload.alertTypeFriendlyName,
        alertDetails: payload.alertDetails,
        source: 'uptimerobot',
      },
      timestamp: new Date(),
    });
  } else if (isUp) {
    await ingestEvent({
      id: newEventId(),
      source: 'schedule',
      kind: 'endpoint_recovered',
      summary: `Endpoint UP: ${payload.monitorFriendlyName} — was down for ${payload.alertDuration ?? 'unknown'}`,
      details: {
        monitor: payload.monitorFriendlyName,
        url: payload.monitorURL,
        downDuration: payload.alertDuration,
        source: 'uptimerobot',
      },
      timestamp: new Date(),
    });
  }
}

// ── API poller ─────────────────────────────────────────────────────

async function fetchMonitors(): Promise<UptimeRobotMonitor[]> {
  const apiKey = process.env.UPTIMEROBOT_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await fetch(`${API_BASE}/getMonitors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        format: 'json',
        // Get 7-day and 30-day uptime ratios
        custom_uptime_ratios: '7-30',
        // Include average response times
        response_times: 1,
        response_times_limit: 1,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const data = (await res.json()) as GetMonitorsResponse;
    if (data.stat !== 'ok' || !data.monitors) return [];
    return data.monitors;
  } catch {
    return [];
  }
}

/** Poll UptimeRobot API and emit events for down monitors or degraded uptime */
export async function checkEndpointUptime(): Promise<void> {
  const monitors = await fetchMonitors();
  if (monitors.length === 0) return;

  for (const monitor of monitors) {
    const statusLabel = STATUS_MAP[monitor.status] ?? 'unknown';

    // Alert on down or seems_down
    if (monitor.status === 8 || monitor.status === 9) {
      await ingestEvent({
        id: newEventId(),
        source: 'schedule',
        kind: 'endpoint_down',
        summary: `Endpoint ${statusLabel.toUpperCase()}: ${monitor.friendly_name} (${monitor.url})`,
        details: {
          monitorId: monitor.id,
          monitor: monitor.friendly_name,
          url: monitor.url,
          status: statusLabel,
          uptimeAll: monitor.all_time_uptime_ratio,
          source: 'uptimerobot_poll',
        },
        timestamp: new Date(),
      });
    }

    // Alert if 7-day uptime drops below 99.5%
    const [uptime7d] = (monitor.custom_uptime_ratio ?? '').split('-');
    const uptime7dPct = parseFloat(uptime7d ?? '100');
    if (uptime7dPct < 99.5 && monitor.status === 2) {
      await ingestEvent({
        id: newEventId(),
        source: 'schedule',
        kind: 'endpoint_uptime_degraded',
        summary: `${monitor.friendly_name} 7-day uptime: ${uptime7dPct}% (below 99.5% target)`,
        details: {
          monitorId: monitor.id,
          monitor: monitor.friendly_name,
          url: monitor.url,
          uptime7d: uptime7dPct,
          uptimeAll: monitor.all_time_uptime_ratio,
          avgResponseMs: parseInt(monitor.average_response_time ?? '0', 10),
          source: 'uptimerobot_poll',
        },
        timestamp: new Date(),
      });
    }
  }
}
