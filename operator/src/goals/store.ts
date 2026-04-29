import { getSql } from '../db.js';
import type { Goal, GoalStatus } from '../types.js';
import { canTransition, newGoalId } from './schema.js';
import { getEventStore } from '../lib/events.js';
import type { EmilyEventType } from '../types/events.js';

function rowToGoal(row: Record<string, unknown>): Goal {
  return {
    id: row.id as string,
    title: row.title as string,
    context: row.context as string,
    objective: row.objective as string,
    riskClass: row.risk_class as Goal['riskClass'],
    approvalRequired: Boolean(row.approval_required),
    status: row.status as GoalStatus,
    toolsUsed: JSON.parse(row.tools_used as string),
    createdAt: new Date(row.created_at as string),
    completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
    outcome: row.outcome as string | null,
  };
}

export async function insertGoal(goal: Goal): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO goals (id, title, context, objective, risk_class, approval_required, status, tools_used, created_at)
    VALUES (${goal.id}, ${goal.title}, ${goal.context}, ${goal.objective}, ${goal.riskClass}, ${goal.approvalRequired}, ${goal.status}, ${JSON.stringify(goal.toolsUsed)}, ${goal.createdAt.toISOString()})
  `;

  await getEventStore().append(goal.id, 'GOAL_CREATED', {
    title: goal.title,
    objective: goal.objective,
    riskClass: goal.riskClass,
    approvalRequired: goal.approvalRequired,
    context: goal.context,
  });
}

export async function getGoal(id: string): Promise<Goal | null> {
  const sql = getSql();
  const rows = await sql`SELECT * FROM goals WHERE id = ${id}`;
  return rows.length > 0 ? rowToGoal(rows[0]) : null;
}

export async function listGoals(filter?: { status?: GoalStatus; limit?: number }): Promise<Goal[]> {
  const sql = getSql();
  let rows;

  if (filter?.status && filter?.limit) {
    rows = await sql`SELECT * FROM goals WHERE status = ${filter.status} ORDER BY created_at DESC LIMIT ${filter.limit}`;
  } else if (filter?.status) {
    rows = await sql`SELECT * FROM goals WHERE status = ${filter.status} ORDER BY created_at DESC`;
  } else if (filter?.limit) {
    rows = await sql`SELECT * FROM goals ORDER BY created_at DESC LIMIT ${filter.limit}`;
  } else {
    rows = await sql`SELECT * FROM goals ORDER BY created_at DESC`;
  }

  return rows.map((r) => rowToGoal(r as Record<string, unknown>));
}

export async function transitionGoal(id: string, newStatus: GoalStatus, outcome?: string): Promise<Goal> {
  const goal = await getGoal(id);
  if (!goal) throw new Error(`Goal not found: ${id}`);
  if (!canTransition(goal.status, newStatus)) {
    throw new Error(`Invalid transition: ${goal.status} -> ${newStatus}`);
  }

  const sql = getSql();
  const completedAt = ['completed', 'failed', 'cancelled'].includes(newStatus)
    ? new Date().toISOString()
    : null;

  await sql`
    UPDATE goals SET status = ${newStatus}, completed_at = ${completedAt}, outcome = ${outcome ?? null} WHERE id = ${id}
  `;

  const statusToEvent: Record<string, EmilyEventType> = {
    approved: 'GOAL_APPROVED',
    active: 'GOAL_ACTIVATED',
    in_progress: 'GOAL_EXECUTION_STARTED',
    completed: 'GOAL_COMPLETED',
    failed: 'GOAL_FAILED',
    cancelled: 'GOAL_CANCELLED',
  };
  const eventType = statusToEvent[newStatus];
  if (eventType) {
    const es = getEventStore();
    await es.append(id, eventType, {
      previousStatus: goal.status,
      newStatus,
      outcome: outcome ?? null,
    });
    // Write snapshot on terminal states
    if (['completed', 'failed', 'cancelled'].includes(newStatus)) {
      const stream = await es.readStream(id);
      const lastSeq = stream.length > 0 ? stream[stream.length - 1].sequence : 0;
      await es.writeSnapshot(id, newStatus as GoalStatus, lastSeq, {
        title: goal.title,
        objective: goal.objective,
        riskClass: goal.riskClass,
        toolsUsed: goal.toolsUsed,
        outcome: outcome ?? null,
      });
    }
  }

  return { ...goal, status: newStatus, completedAt: completedAt ? new Date(completedAt) : null, outcome: outcome ?? null };
}

export async function addToolToGoal(goalId: string, toolName: string): Promise<void> {
  const goal = await getGoal(goalId);
  if (!goal) return;

  const tools = [...goal.toolsUsed, toolName];
  const sql = getSql();
  await sql`UPDATE goals SET tools_used = ${JSON.stringify(tools)} WHERE id = ${goalId}`;
}

export async function getActiveGoals(): Promise<Goal[]> {
  const active = await listGoals({ status: 'active' });
  const inProgress = await listGoals({ status: 'in_progress' });
  return active.concat(inProgress);
}

/** Check for an existing non-terminal goal with the same title (dedup guard). */
export async function findNonTerminalGoalByTitle(title: string): Promise<Goal | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM goals WHERE title = ${title} AND status NOT IN ('completed', 'failed', 'cancelled') LIMIT 1
  `;
  return rows.length > 0 ? rowToGoal(rows[0] as Record<string, unknown>) : null;
}
