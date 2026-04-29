import crypto from 'node:crypto';
import type { ClusterEvent } from '../types.js';
import { ingestEvent, newEventId } from './index.js';
import { findToolByName } from '../tools/index.js';
import { logToolExecution } from '../audit.js';
import { emit } from '../lib/events.js';

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? '';
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? '';

// ── Signature Verification ─────────────────────────────────────────

export function verifySlackSignature(
  signature: string | undefined,
  timestamp: string | undefined,
  rawBody: string,
): boolean {
  if (!SIGNING_SECRET || !signature || !timestamp) return false;

  // Reject requests older than 5 minutes
  const ts = parseInt(timestamp, 10);
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', SIGNING_SECRET).update(baseString).digest('hex');
  const expected = `v0=${hmac}`;

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ── Slack Command Handling ─────────────────────────────────────────

export interface SlackCommandPayload {
  command: string;
  text: string;
  user_id: string;
  user_name: string;
  channel_id: string;
  channel_name: string;
  response_url: string;
}

/**
 * Handle a Slack slash command.
 * Parses the command text and feeds it into the triage pipeline.
 */
export async function handleSlackCommand(payload: SlackCommandPayload): Promise<void> {
  await ingestEvent({
    id: newEventId(),
    source: 'slack',
    kind: 'slash_command',
    summary: `${payload.user_name}: ${payload.command} ${payload.text}`,
    details: {
      userId: payload.user_id,
      userName: payload.user_name,
      channelId: payload.channel_id,
      channelName: payload.channel_name,
      text: payload.text,
      responseUrl: payload.response_url,
    },
    timestamp: new Date(),
  });
}

// ── Slack Events API ───────────────────────────────────────────────

export interface SlackEventPayload {
  type: string;
  token?: string;
  challenge?: string;
  event?: {
    type: string;
    user?: string;
    text?: string;
    channel?: string;
    reaction?: string;
    item?: { type: string; channel: string; ts: string };
    ts?: string;
  };
}

/**
 * Handle Slack Events API payload.
 * Returns the challenge response for url_verification, or processes the event.
 */
export async function handleSlackEvent(
  payload: SlackEventPayload,
): Promise<{ challenge?: string } | void> {
  // Slack url_verification handshake
  if (payload.type === 'url_verification') {
    return { challenge: payload.challenge };
  }

  if (payload.type !== 'event_callback' || !payload.event) return;

  const event = payload.event;

  if (event.type === 'app_mention' && event.text) {
    // Strip the bot mention from the text
    const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!text) return;

    await ingestEvent({
      id: newEventId(),
      source: 'slack',
      kind: 'app_mention',
      summary: `Slack mention: ${text}`,
      details: {
        userId: event.user,
        channelId: event.channel,
        text,
        ts: event.ts,
      },
      timestamp: new Date(),
    });
  }

  if (event.type === 'message' && event.channel && event.text) {
    await ingestEvent({
      id: newEventId(),
      source: 'slack',
      kind: 'direct_message',
      summary: `Slack DM: ${event.text}`,
      details: {
        userId: event.user,
        channelId: event.channel,
        text: event.text,
        ts: event.ts,
      },
      timestamp: new Date(),
    });
  }

  if (event.type === 'reaction_added' && event.reaction && event.item) {
    await ingestEvent({
      id: newEventId(),
      source: 'slack',
      kind: 'reaction',
      summary: `Reaction :${event.reaction}: on message`,
      details: {
        userId: event.user,
        reaction: event.reaction,
        itemChannel: event.item.channel,
        itemTs: event.item.ts,
      },
      timestamp: new Date(),
    });
  }
}

// ── Slack Interactive (Buttons/Actions) ────────────────────────────

export interface SlackInteractivePayload {
  type: string;
  user: { id: string; username: string };
  channel?: { id: string };
  actions?: Array<{
    action_id: string;
    value: string;
  }>;
  response_url?: string;
}

/**
 * Handle Slack interactive payloads (button clicks, menus).
 * Returns a response message for the interaction.
 */
export async function handleSlackInteractive(
  payload: SlackInteractivePayload,
): Promise<{ text: string }> {
  if (payload.type !== 'block_actions' || !payload.actions?.length) {
    return { text: 'Unknown interaction type' };
  }

  const action = payload.actions[0];

  if (action.action_id === 'approve_tool') {
    await ingestEvent({
      id: newEventId(),
      source: 'slack',
      kind: 'approval',
      summary: `${payload.user.username} approved: ${action.value}`,
      details: {
        userId: payload.user.id,
        userName: payload.user.username,
        action: 'approve',
        toolPayload: action.value,
        responseUrl: payload.response_url,
      },
      timestamp: new Date(),
    });

    // Execute the approved tool synchronously. The Slack payload carries
    // {goalId, tool, input} — the original goal has already transitioned
    // to `failed` with outcome "Needs approval". Re-involving the LLM to
    // replay the tool would risk it choosing something different from
    // what the human actually approved; running the exact input keeps
    // the approval specific and auditable.
    let toolPayload: { goalId?: string; tool?: string; input?: Record<string, unknown> };
    try {
      toolPayload = JSON.parse(action.value);
    } catch {
      return { text: `Approved by ${payload.user.username}, but payload was malformed — no action taken.` };
    }
    const toolName = toolPayload.tool;
    const input = toolPayload.input ?? {};
    const goalId = toolPayload.goalId ?? 'unknown';
    if (!toolName) {
      return { text: `Approved by ${payload.user.username}, but payload had no tool name — no action taken.` };
    }
    const tool = findToolByName(toolName);
    if (!tool) {
      return { text: `Approved by ${payload.user.username}, but tool "${toolName}" is unknown — no action taken.` };
    }

    emit(goalId, 'TOOL_APPROVAL_GRANTED', {
      toolName,
      approvedBy: payload.user.username,
      inputSummary: JSON.stringify(input).slice(0, 500),
    });

    try {
      const result = await tool.execute(input);
      await logToolExecution({
        userId: `slack:${payload.user.username}`,
        toolName,
        toolInput: input,
        toolTier: tool.tier,
        result,
        goalId,
      });
      emit(goalId, 'TOOL_EXECUTED', {
        toolName,
        toolTier: tool.tier,
        inputSummary: JSON.stringify(input).slice(0, 500),
        resultSummary: (typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 500),
      });
      const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      const truncated = resultText.length > 1500 ? resultText.slice(0, 1500) + '…' : resultText;
      return { text: `Approved by ${payload.user.username}. Ran \`${toolName}\`:\n\`\`\`${truncated}\`\`\`` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit(goalId, 'TOOL_FAILED', {
        toolName,
        error: msg,
      });
      return { text: `Approved by ${payload.user.username} but \`${toolName}\` failed: ${msg}` };
    }
  }

  if (action.action_id === 'deny_tool') {
    await ingestEvent({
      id: newEventId(),
      source: 'slack',
      kind: 'approval',
      summary: `${payload.user.username} denied: ${action.value}`,
      details: {
        userId: payload.user.id,
        userName: payload.user.username,
        action: 'deny',
        toolPayload: action.value,
        responseUrl: payload.response_url,
      },
      timestamp: new Date(),
    });
    try {
      const p = JSON.parse(action.value) as { goalId?: string; tool?: string };
      emit(p.goalId ?? 'unknown', 'TOOL_APPROVAL_DENIED', {
        toolName: p.tool ?? '?',
        deniedBy: payload.user.username,
      });
    } catch { /* malformed payload — best-effort log already happened */ }
    return { text: `Denied by ${payload.user.username}` };
  }

  return { text: 'Unknown action' };
}

// ── Send Messages ──────────────────────────────────────────────────

/** Slack section block text has a 3000 char hard limit. */
const SLACK_SECTION_LIMIT = 3000;

/** Split text into chunks that fit within Slack section block limits. */
function splitIntoSectionBlocks(text: string): Array<{ type: 'section'; text: { type: 'mrkdwn'; text: string } }> {
  if (text.length <= SLACK_SECTION_LIMIT) {
    return [{ type: 'section', text: { type: 'mrkdwn', text } }];
  }

  const blocks: Array<{ type: 'section'; text: { type: 'mrkdwn'; text: string } }> = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= SLACK_SECTION_LIMIT) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: remaining } });
      break;
    }
    const chunk = remaining.slice(0, SLACK_SECTION_LIMIT);
    // Break at last newline to avoid splitting mid-sentence
    const breakAt = chunk.lastIndexOf('\n');
    const splitPos = breakAt > SLACK_SECTION_LIMIT * 0.3 ? breakAt : SLACK_SECTION_LIMIT;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: remaining.slice(0, splitPos) } });
    remaining = remaining.slice(splitPos).replace(/^\n/, '');
  }

  // Slack allows max 50 blocks — cap at 10 sections to be reasonable
  return blocks.slice(0, 10);
}

export { splitIntoSectionBlocks };

export async function sendSlackMessage(params: {
  channel?: string;
  responseUrl?: string;
  text: string;
  blocks?: unknown[];
}): Promise<void> {
  if (params.responseUrl) {
    const resp = await fetch(params.responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: params.text,
        ...(params.blocks ? { blocks: params.blocks } : {}),
      }),
    });
    if (!resp.ok) {
      console.warn(`Slack responseUrl failed: ${resp.status} ${await resp.text().catch(() => '')}`);
    }
    return;
  }

  if (params.channel && BOT_TOKEN) {
    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel: params.channel,
        text: params.text,
        ...(params.blocks ? { blocks: params.blocks } : {}),
      }),
    });
    const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
    if (!body.ok) {
      console.warn(`Slack chat.postMessage failed: ${body.error ?? 'unknown'}`, {
        channel: params.channel,
        textLength: params.text.length,
        blockCount: params.blocks?.length,
      });
    }
  }
}
