import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://operator_user:operator-changeme@postgres-rw.platform.svc.cluster.local:5432/k3s_operator';

let _sql: postgres.Sql | null = null;

export function getSql(): postgres.Sql {
  if (_sql) return _sql;

  _sql = postgres(DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return _sql;
}

export async function initSchema(): Promise<void> {
  const sql = getSql();

  await sql`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '',
      objective TEXT NOT NULL,
      risk_class TEXT NOT NULL DEFAULT 'low',
      approval_required BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'proposed',
      tools_used TEXT NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      outcome TEXT
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input TEXT NOT NULL DEFAULT '{}',
      tool_tier INTEGER NOT NULL,
      result TEXT,
      goal_id TEXT REFERENCES goals(id)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)`;

  await sql`
    CREATE TABLE IF NOT EXISTS entity_memory (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_name TEXT NOT NULL,
      fact TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'operator',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_entity_name ON entity_memory(entity_type, entity_name)`;

  await sql`
    CREATE TABLE IF NOT EXISTS episodic_memory (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_episodic_tags ON episodic_memory(tags)`;

  await sql`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}',
      triage_decision TEXT,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_events_source ON events(source, timestamp)`;

  await sql`
    CREATE TABLE IF NOT EXISTS conversation_log (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      goal_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_convlog_session ON conversation_log(session_id, created_at)`;

  // ── Event sourcing tables ──────────────────────────────────────────

  await sql`
    CREATE TABLE IF NOT EXISTS goal_events (
      id BIGSERIAL PRIMARY KEY,
      goal_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'emily',
      payload JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_goal_events_goal_sequence UNIQUE (goal_id, sequence)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_goal_events_goal_id ON goal_events(goal_id, sequence)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_goal_events_type ON goal_events(event_type, created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_goal_events_created ON goal_events(created_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS goal_snapshots (
      goal_id TEXT PRIMARY KEY,
      current_state TEXT NOT NULL,
      last_sequence INTEGER NOT NULL,
      snapshot JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // ── Feedback reports (daily self-analysis runs) ────────────────────
  // Immutable log of what Claude-as-reviewer thought about the
  // operator's own decisions. Used to detect over-cautious blocking,
  // incorrect approval escalations, and (future) decision quality.
  await sql`
    CREATE TABLE IF NOT EXISTS feedback_reports (
      id TEXT PRIMARY KEY,
      focus TEXT NOT NULL,
      window_start TIMESTAMPTZ NOT NULL,
      window_end TIMESTAMPTZ NOT NULL,
      decisions_reviewed INTEGER NOT NULL DEFAULT 0,
      issues_found INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      findings JSONB NOT NULL DEFAULT '[]',
      raw_input JSONB NOT NULL DEFAULT '{}',
      raw_response TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_feedback_reports_focus ON feedback_reports(focus, created_at)`;
}

export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}
