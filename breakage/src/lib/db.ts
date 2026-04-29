import postgres from 'postgres';

/**
 * Breakage framework database connection. Target: native Postgres 17
 * on the orch VM (pgvector already installed there).
 *
 * Defaults to a dedicated `breakage` role + database; override via
 * BREAKAGE_DATABASE_URL. Keep this separate from the operator's
 * `k3s_operator` database so scenario traffic doesn't mix with
 * Emily's production goal store.
 */
const DATABASE_URL =
  process.env.BREAKAGE_DATABASE_URL
  ?? 'postgresql://breakage:breakage-changeme@127.0.0.1:5432/breakage';

let _sql: postgres.Sql | null = null;

export function getSql(): postgres.Sql {
  if (_sql) return _sql;
  _sql = postgres(DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    // pgvector types — the postgres driver doesn't know vector natively;
    // we pass embeddings as stringified arrays via `::vector` casts.
    types: {},
  });
  return _sql;
}

export async function closeSql(): Promise<void> {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
  }
}
