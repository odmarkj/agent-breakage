import Fastify from 'fastify';
import { runAgent } from './agent.js';
import { getToolsForRole } from './tools/index.js';
import { handleGitHubWebhook } from './watchers/github.js';
import { handleAlertManagerWebhook } from './watchers/metrics.js';
import {
  handleSlackCommand,
  handleSlackEvent,
  handleSlackInteractive,
  verifySlackSignature,
  type SlackCommandPayload,
  type SlackEventPayload,
  type SlackInteractivePayload,
} from './watchers/slack.js';
import { startKubernetesWatcher, stopKubernetesWatcher } from './watchers/kubernetes.js';
import { startScheduledChecks, stopScheduledChecks } from './watchers/schedule.js';
import { onTriagedEvent, startWatcherCleanup, stopWatcherCleanup } from './watchers/index.js';
import { handleUptimeRobotWebhook, type UptimeRobotWebhookPayload } from './watchers/uptimerobot.js';
import { initStableMemory } from './memory/stable.js';
import { initLearningMemory } from './memory/learnings.js';
import { initSchema, closeDb } from './db.js';
import { listGoals } from './goals/store.js';
import { getRecentAuditEntries } from './audit.js';
import { createGoal } from './goals/schema.js';
import { insertGoal, findNonTerminalGoalByTitle } from './goals/store.js';
import { startConsolidation, stopConsolidation } from './reflection/consolidator.js';
import {
  startFeedbackLoop,
  stopFeedbackLoop,
  runFeedbackAnalysis,
  getRecentFeedbackReports,
  type FeedbackFocus,
} from './reflection/feedback.js';
import { startGoalExecutor, stopGoalExecutor } from './goals/executor.js';
// autoscaler is event-driven (reacts to AlertManager webhooks in watchers/metrics.ts)
import { addEntityFact, getEntityFacts } from './memory/entity.js';
import { sendSlackMessage } from './watchers/slack.js';
import type { ChatRequest, SSEEvent } from './types.js';
import querystring from 'node:querystring';
import { emit, getEventStore } from './lib/events.js';
import { TRIAGE_AGGREGATE_ID, SYSTEM_AGGREGATE_ID } from './types/events.js';

const SLACK_CHANNEL_ALERTS = process.env.SLACK_CHANNEL_ALERTS ?? '#k3s';

const app = Fastify({ logger: true });

// Slack sends slash commands and interactive payloads as application/x-www-form-urlencoded
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
  done(null, querystring.parse(body as string));
});

// ── Initialize subsystems ───────────────────────────────────────────

// Stable memory (loads context/ files)
initStableMemory();

// Learning memory (Emily's evolved knowledge)
initLearningMemory();

// Register event handler for triaged events
onTriagedEvent(async (event, decision) => {
  app.log.info({ event: event.summary, decision }, 'Triaged event');

  // Create goals for actionable decisions
  if (decision === 'routine' || decision === 'urgent' || decision === 'escalate') {
    const riskClass = decision === 'escalate' ? 'high' : decision === 'urgent' ? 'medium' : 'low';

    // Goal-level deduplication: skip if a non-terminal goal already exists for this issue
    const existingGoal = await findNonTerminalGoalByTitle(event.summary);
    if (existingGoal) {
      emit(TRIAGE_AGGREGATE_ID, 'EVENT_DEDUPLICATED', {
        eventSummary: event.summary,
        existingGoalId: existingGoal.id,
        existingStatus: existingGoal.status,
      });
      app.log.info(
        { existingGoalId: existingGoal.id, status: existingGoal.status },
        `Skipping duplicate goal for: ${event.summary}`,
      );
      return;
    }

    const goal = createGoal({
      title: event.summary,
      objective: `Investigate and resolve: ${event.summary}`,
      context: JSON.stringify(event.details),
      riskClass,
      approvalRequired: decision === 'escalate',
    });
    await insertGoal(goal);
    app.log.info({ goalId: goal.id, decision }, 'Auto-created goal from triaged event');

    // Send Slack alert for actionable events
    const emoji = decision === 'escalate' ? '🚨' : decision === 'urgent' ? '⚠️' : 'ℹ️';
    const label = decision.toUpperCase();
    try {
      await sendSlackMessage({
        channel: SLACK_CHANNEL_ALERTS,
        text: `${emoji} *[${label}]* ${event.summary}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${emoji} *[${label}]* ${event.summary}\n*Source:* ${event.source} | *Kind:* ${event.kind} | *Goal:* \`${goal.id}\``,
            },
          },
        ],
      });
    } catch (err) {
      app.log.warn({ err }, 'Failed to send Slack alert');
    }
  }

  // Record entity facts for recurring issues
  if (decision !== 'ignore' && decision !== 'log') {
    const ns = event.details.namespace as string | undefined;
    const pod = event.details.pod as string | undefined;
    if (ns && pod) {
      const deployment = pod.replace(/-[a-z0-9]+-[a-z0-9]+$/, '');
      const existing = await getEntityFacts('service', deployment);
      const isDuplicate = existing.some((f) => f.fact === event.summary);
      if (!isDuplicate) {
        await addEntityFact('service', deployment, event.summary, event.source);
      }
    }
  }
});

// ── Tool Execution Endpoint ─────────────────────────────────────────

interface ToolExecBody {
  toolName: string;
  toolInput: Record<string, unknown>;
  userRole: 'admin' | 'user';
  userId: string;
}

app.post<{ Body: ToolExecBody }>('/tools/execute', async (request, reply) => {
  const { toolName, toolInput, userRole } = request.body;

  if (!toolName) {
    return reply.status(400).send({ error: 'toolName is required' });
  }

  const tools = getToolsForRole(userRole);
  const tool = tools.find((t) => t.name === toolName);

  if (!tool) {
    return reply.status(404).send({ error: `Tool "${toolName}" not found or not permitted for role "${userRole}"` });
  }

  try {
    const result = await tool.execute(toolInput ?? {});
    return { result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: message });
  }
});

// ── Chat Endpoint (SSE streaming) ───────────────────────────────────

app.post<{ Body: ChatRequest }>('/chat', async (request, reply) => {
  const body = request.body;

  if (!body.message?.trim()) {
    return reply.status(400).send({ error: 'Empty message' });
  }

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const sendEvent = (event: SSEEvent) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    for await (const event of runAgent(body)) {
      sendEvent(event);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendEvent({ type: 'error', content: msg });
    sendEvent({ type: 'done' });
  } finally {
    reply.raw.end();
  }
});

// ── Webhook Endpoints ───────────────────────────────────────────────

app.post('/webhook/github', async (request) => {
  const eventType = request.headers['x-github-event'] as string;
  const payload = request.body as Record<string, unknown>;

  app.log.info({ eventType }, 'GitHub webhook received');
  await handleGitHubWebhook(eventType, payload);

  return { received: true, event: eventType };
});

app.post('/webhook/alertmanager', async (request) => {
  const payload = request.body as Record<string, unknown>;

  app.log.info('AlertManager webhook received');
  await handleAlertManagerWebhook(payload as any);

  return { received: true };
});

// Slack Events API (url_verification + event callbacks)
app.post('/webhook/slack/events', async (request, reply) => {
  const payload = request.body as SlackEventPayload;

  // url_verification doesn't need signature check
  if (payload.type === 'url_verification') {
    return { challenge: payload.challenge };
  }

  const sig = request.headers['x-slack-signature'] as string | undefined;
  const ts = request.headers['x-slack-request-timestamp'] as string | undefined;
  const rawBody = JSON.stringify(request.body);

  if (!verifySlackSignature(sig, ts, rawBody)) {
    app.log.warn('Slack signature verification failed');
    return reply.status(401).send({ error: 'Invalid signature' });
  }

  app.log.info({ eventType: payload.event?.type }, 'Slack event received');
  const result = await handleSlackEvent(payload);
  return result ?? { ok: true };
});

// Slack Slash Commands
app.post('/webhook/slack', async (request, reply) => {
  const payload = request.body as SlackCommandPayload;

  app.log.info({ command: payload.command, user: payload.user_name }, 'Slack slash command');
  await handleSlackCommand(payload);

  return { response_type: 'in_channel', text: `Processing: ${payload.text}` };
});

// Slack Interactive (button clicks, menus)
app.post('/webhook/slack/interactive', async (request, reply) => {
  // Slack sends interactive payloads as form-encoded with a `payload` field
  const raw = (request.body as any)?.payload ?? request.body;
  const payload: SlackInteractivePayload = typeof raw === 'string' ? JSON.parse(raw) : raw;

  app.log.info({ type: payload.type, user: payload.user?.username }, 'Slack interactive');
  return handleSlackInteractive(payload);
});

// ── UptimeRobot Webhook ────────────────────────────────────────────

app.post('/webhook/uptimerobot', async (request) => {
  // UptimeRobot sends webhooks as query string params or POST body
  const payload = request.body as UptimeRobotWebhookPayload;

  app.log.info({ monitor: payload.monitorFriendlyName, alert: payload.alertTypeFriendlyName }, 'UptimeRobot webhook received');
  await handleUptimeRobotWebhook(payload);

  return { received: true };
});

// ── Status & Health ─────────────────────────────────────────────────

// ── Event Sourcing Endpoints ───────────────────────────────────────

app.get<{ Params: { id: string } }>('/goals/:id/events', async (request) => {
  const events = await getEventStore().readStream(request.params.id);
  return { goalId: request.params.id, events };
});

app.get('/events/recent', async (request) => {
  const limit = parseInt((request.query as Record<string, string>).limit ?? '50', 10);
  const events = await getEventStore().readRecent(limit);
  return { events };
});

app.get<{ Params: { id: string } }>('/goals/:id/timeline', async (request) => {
  const timeline = await getEventStore().goalTimeline(request.params.id);
  return { goalId: request.params.id, timeline };
});

// ── Feedback / Self-Review Endpoints ───────────────────────────────

interface FeedbackRunBody {
  focus?: FeedbackFocus;
  windowHours?: number;
  notifySlack?: boolean;
}

// On-demand trigger — useful for the nightly Slack-digest-to-Claude workflow.
app.post<{ Body: FeedbackRunBody }>('/feedback/analyze', async (request, reply) => {
  const body = request.body ?? {};
  try {
    const report = await runFeedbackAnalysis({
      focus: body.focus,
      windowHours: body.windowHours,
      notifySlack: body.notifySlack,
    });
    if (!report) {
      return { status: 'no_events_in_window' };
    }
    return { status: 'ok', report };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: msg });
  }
});

app.get('/feedback/reports', async (request) => {
  const limit = parseInt((request.query as Record<string, string>).limit ?? '20', 10);
  const reports = await getRecentFeedbackReports(limit);
  return { reports };
});

// ── Status & Health ─────────────────────────────────────────────────

app.get('/health', async () => ({ status: 'ok' }));

app.get('/status', async () => {
  const activeGoals = await listGoals({ status: 'active', limit: 5 });
  const recentAudit = await getRecentAuditEntries(10);

  return {
    status: 'running',
    uptime: process.uptime(),
    goals: {
      active: activeGoals.length,
      recent: activeGoals.map((g) => ({ id: g.id, title: g.title, status: g.status })),
    },
    recentAudit: recentAudit.map((a) => ({
      tool: a.toolName,
      tier: a.toolTier,
      time: a.timestamp.toISOString(),
    })),
    tools: getToolsForRole('admin').map((t) => ({
      name: t.name,
      tier: t.tier,
    })),
  };
});

// ── Start ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const ENABLE_WATCHERS = process.env.ENABLE_WATCHERS !== 'false';

async function start(): Promise<void> {
  // Initialize database schema
  await initSchema();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`K3S Operator listening on :${PORT}`);

  emit(SYSTEM_AGGREGATE_ID, 'SYSTEM_STARTUP', {
    port: PORT,
    watchersEnabled: ENABLE_WATCHERS,
  });

  if (ENABLE_WATCHERS) {
    app.log.info('Starting watchers...');
    startKubernetesWatcher(60_000); // poll every 60s
    startScheduledChecks();
    startWatcherCleanup();
    startConsolidation(); // nightly event consolidation into episodic memory
    startFeedbackLoop(); // daily self-review: was the operator blocked/asking approval correctly?
    startGoalExecutor(); // autonomous goal execution loop (polls every 30s)
    app.log.info('Watchers, consolidation, feedback loop, and goal executor started (autoscaler is event-driven via AlertManager webhooks)');
  } else {
    app.log.info('Watchers disabled (set ENABLE_WATCHERS=true to enable)');
  }
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// ── Graceful shutdown ───────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  app.log.info(`${signal} received, shutting down...`);

  try {
    await getEventStore().append(SYSTEM_AGGREGATE_ID, 'SYSTEM_SHUTDOWN', {
      signal,
      uptime: process.uptime(),
    });
  } catch { /* best-effort */ }

  stopKubernetesWatcher();
  stopScheduledChecks();
  stopWatcherCleanup();
  stopConsolidation();
  stopFeedbackLoop();
  stopGoalExecutor();
  await closeDb();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
