import { getSql } from '../db.js';

/**
 * Session continuity: maintains a rolling 24-hour conversation context
 * across goal executions so Emily remembers what she already investigated.
 *
 * Instead of replaying raw message history (which would blow up the context window),
 * recent conversation is summarized and injected into the system prompt.
 */

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CONTENT_LENGTH = 2048; // Truncate large tool results

let _sessionId: string | null = null;
let _sessionCreatedAt: number | null = null;

/** Get or create a 24-hour session ID. */
export function getOrCreateSessionId(): string {
  const now = Date.now();

  if (_sessionId && _sessionCreatedAt && now - _sessionCreatedAt < SESSION_TTL_MS) {
    return _sessionId;
  }

  _sessionId = `session_${now}_${Math.random().toString(36).slice(2, 8)}`;
  _sessionCreatedAt = now;
  return _sessionId;
}

/** Append a conversation message to the session log. */
export async function appendConversationMessage(
  sessionId: string,
  goalId: string | null,
  role: 'user' | 'assistant' | 'tool_result',
  content: string,
): Promise<void> {
  const sql = getSql();
  const truncated = content.length > MAX_CONTENT_LENGTH
    ? content.slice(0, MAX_CONTENT_LENGTH) + '\n...(truncated)'
    : content;

  await sql`
    INSERT INTO conversation_log (session_id, goal_id, role, content)
    VALUES (${sessionId}, ${goalId}, ${role}, ${truncated})
  `;
}

interface ConversationEntry {
  goalId: string | null;
  role: string;
  content: string;
  createdAt: string;
}

/**
 * Get recent conversation history for system prompt injection.
 * Returns entries grouped by goal, formatted as a readable summary.
 */
export async function getSessionHistory(sessionId: string, maxEntries = 30): Promise<ConversationEntry[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT goal_id, role, content, created_at
    FROM conversation_log
    WHERE session_id = ${sessionId}
    ORDER BY created_at DESC
    LIMIT ${maxEntries}
  `;

  return rows.reverse().map((r) => ({
    goalId: r.goal_id as string | null,
    role: r.role as string,
    content: r.content as string,
    createdAt: (r.created_at as Date).toISOString(),
  }));
}

/**
 * Format session history for system prompt injection.
 * Produces a condensed summary of what Emily investigated in prior goals.
 */
export async function formatSessionHistoryForPrompt(sessionId: string, currentGoalId: string): Promise<string> {
  const entries = await getSessionHistory(sessionId);

  // Filter out current goal's entries (those will be in the live conversation)
  const priorEntries = entries.filter((e) => e.goalId !== currentGoalId);
  if (priorEntries.length === 0) return '';

  // Group by goal
  const goalGroups = new Map<string, ConversationEntry[]>();
  for (const entry of priorEntries) {
    const key = entry.goalId ?? 'unknown';
    const group = goalGroups.get(key) ?? [];
    group.push(entry);
    goalGroups.set(key, group);
  }

  const parts: string[] = [];
  for (const [goalId, group] of goalGroups) {
    // Extract assistant summaries (skip user prompts and raw tool results for brevity)
    const assistantMessages = group
      .filter((e) => e.role === 'assistant')
      .map((e) => e.content);

    if (assistantMessages.length === 0) continue;

    // Take the last assistant message as the summary of that goal's investigation
    const lastSummary = assistantMessages[assistantMessages.length - 1];
    parts.push(`**Goal ${goalId}:** ${lastSummary.slice(0, 500)}`);
  }

  if (parts.length === 0) return '';

  return `## Recent Investigation History (this session)\n${parts.join('\n\n')}\n`;
}

/** Delete conversation log entries older than 24 hours. */
export async function cleanupOldSessions(): Promise<void> {
  const sql = getSql();
  await sql`DELETE FROM conversation_log WHERE created_at < NOW() - INTERVAL '24 hours'`;
}
