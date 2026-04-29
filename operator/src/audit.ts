import { getSql } from './db.js';
import type { AuditEntry, ToolTier } from './types.js';

function newId(): string {
  return `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Record a tool execution in the audit log.
 * Called for all Tier 2 and Tier 3 tool executions.
 */
export async function logToolExecution(params: {
  userId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolTier: ToolTier;
  result: unknown;
  goalId?: string;
}): Promise<string> {
  const sql = getSql();
  const id = newId();
  const resultStr = typeof params.result === 'string' ? params.result : JSON.stringify(params.result);

  await sql`
    INSERT INTO audit_log (id, user_id, tool_name, tool_input, tool_tier, result, goal_id)
    VALUES (${id}, ${params.userId}, ${params.toolName}, ${JSON.stringify(params.toolInput)}, ${params.toolTier}, ${resultStr}, ${params.goalId ?? null})
  `;

  return id;
}

export async function getRecentAuditEntries(limit = 20): Promise<AuditEntry[]> {
  const sql = getSql();
  const rows = await sql`SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ${limit}`;

  return rows.map((r) => ({
    id: r.id as string,
    timestamp: new Date(r.timestamp as string),
    userId: r.user_id as string,
    toolName: r.tool_name as string,
    toolInput: JSON.parse(r.tool_input as string),
    toolTier: r.tool_tier as ToolTier,
    result: r.result,
    goalId: r.goal_id as string | undefined,
  }));
}

export async function getAuditEntriesForGoal(goalId: string): Promise<AuditEntry[]> {
  const sql = getSql();
  const rows = await sql`SELECT * FROM audit_log WHERE goal_id = ${goalId} ORDER BY timestamp ASC`;

  return rows.map((r) => ({
    id: r.id as string,
    timestamp: new Date(r.timestamp as string),
    userId: r.user_id as string,
    toolName: r.tool_name as string,
    toolInput: JSON.parse(r.tool_input as string),
    toolTier: r.tool_tier as ToolTier,
    result: r.result,
    goalId: r.goal_id as string | undefined,
  }));
}
