import type postgres from 'postgres';
import type { EmilyEventType, GoalEvent, GoalSnapshot } from '../types/events.js';
import type { GoalStatus } from '../types.js';

export class EventStore {
  private sql: postgres.Sql;

  constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  async append(
    goalId: string,
    eventType: EmilyEventType,
    payload: Record<string, unknown>,
    actor: string = 'emily',
  ): Promise<GoalEvent> {
    // Truncate oversized payloads
    const payloadStr = JSON.stringify(payload);
    const safePayload =
      payloadStr.length > 10_000
        ? { _truncated: true, _originalSize: payloadStr.length }
        : payload;

    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const rows = await this.sql.begin(async (sql) => {
          await sql`SELECT pg_advisory_xact_lock(hashtext(${goalId}))`;
          return sql`
            INSERT INTO goal_events (goal_id, sequence, event_type, actor, payload)
            SELECT
              ${goalId},
              COALESCE(MAX(sequence), 0) + 1,
              ${eventType},
              ${actor},
              ${JSON.stringify(safePayload)}::jsonb
            FROM goal_events
            WHERE goal_id = ${goalId}
            RETURNING *
          `;
        });
        const row = rows[0];
        return {
          id: row.id as number,
          goalId: row.goal_id as string,
          sequence: row.sequence as number,
          eventType: row.event_type as EmilyEventType,
          actor: row.actor as string,
          payload: row.payload as Record<string, unknown>,
          createdAt: row.created_at as Date,
        };
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr.code === '23505' && attempt < maxAttempts) {
          continue;
        }
        throw err;
      }
    }
    throw new Error('EventStore.append: exhausted retry attempts');
  }

  async readStream(goalId: string, fromSequence: number = 0): Promise<GoalEvent[]> {
    const rows = await this.sql`
      SELECT * FROM goal_events
      WHERE goal_id = ${goalId} AND sequence > ${fromSequence}
      ORDER BY sequence ASC
    `;
    return rows.map((row) => ({
      id: row.id as number,
      goalId: row.goal_id as string,
      sequence: row.sequence as number,
      eventType: row.event_type as EmilyEventType,
      actor: row.actor as string,
      payload: row.payload as Record<string, unknown>,
      createdAt: row.created_at as Date,
    }));
  }

  async readRecent(limit: number = 50): Promise<GoalEvent[]> {
    const rows = await this.sql`
      SELECT * FROM goal_events ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map((row) => ({
      id: row.id as number,
      goalId: row.goal_id as string,
      sequence: row.sequence as number,
      eventType: row.event_type as EmilyEventType,
      actor: row.actor as string,
      payload: row.payload as Record<string, unknown>,
      createdAt: row.created_at as Date,
    }));
  }

  async readByType(eventType: EmilyEventType, limit: number = 50): Promise<GoalEvent[]> {
    const rows = await this.sql`
      SELECT * FROM goal_events
      WHERE event_type = ${eventType}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map((row) => ({
      id: row.id as number,
      goalId: row.goal_id as string,
      sequence: row.sequence as number,
      eventType: row.event_type as EmilyEventType,
      actor: row.actor as string,
      payload: row.payload as Record<string, unknown>,
      createdAt: row.created_at as Date,
    }));
  }

  async getLatestSnapshot(goalId: string): Promise<GoalSnapshot | null> {
    const rows = await this.sql`
      SELECT * FROM goal_snapshots WHERE goal_id = ${goalId}
    `;
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      goalId: row.goal_id as string,
      currentState: row.current_state as GoalStatus,
      lastSequence: row.last_sequence as number,
      snapshot: row.snapshot as Record<string, unknown>,
      updatedAt: row.updated_at as Date,
    };
  }

  async writeSnapshot(
    goalId: string,
    currentState: GoalStatus,
    lastSequence: number,
    snapshot: Record<string, unknown>,
  ): Promise<void> {
    await this.sql`
      INSERT INTO goal_snapshots (goal_id, current_state, last_sequence, snapshot, updated_at)
      VALUES (${goalId}, ${currentState}, ${lastSequence}, ${JSON.stringify(snapshot)}::jsonb, NOW())
      ON CONFLICT (goal_id) DO UPDATE SET
        current_state = EXCLUDED.current_state,
        last_sequence = EXCLUDED.last_sequence,
        snapshot = EXCLUDED.snapshot,
        updated_at = NOW()
    `;
  }

  async goalTimeline(goalId: string): Promise<string> {
    const events = await this.readStream(goalId);
    return events
      .map(
        (e) =>
          `[${e.createdAt.toISOString()}] ${e.eventType} (${e.actor}): ${JSON.stringify(e.payload).slice(0, 200)}`,
      )
      .join('\n');
  }
}
