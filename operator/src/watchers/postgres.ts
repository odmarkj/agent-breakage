import { execSync } from 'node:child_process';
import { ingestEvent, newEventId } from './index.js';

/**
 * PostgreSQL health monitoring.
 * Runs psql commands via kubectl exec into the postgres pod.
 */

const PG_NAMESPACE = 'platform';
const PG_POD_LABEL = 'cnpg.io/cluster=postgres,cnpg.io/instanceRole=primary';

/** Max connections before alerting (postgres default is 100) */
const CONNECTION_THRESHOLD = 80;
/** Queries running longer than this (seconds) trigger an alert */
const LONG_QUERY_SECONDS = 300;
/** Database size warning threshold in MB */
const DB_SIZE_WARNING_MB = 7_000; // ~7GB of 10Gi PVC

// Runs as `operator_user` (granted pg_monitor + pg_read_all_data), not the
// postgres superuser. The watcher only needs read access to system catalogs
// and pg_stat_*; there is no legitimate reason for it to authenticate as a
// role that could `ALTER USER` or mutate cluster state.
const OPERATOR_PG_USER = 'operator_user';

// Password sourced from the DATABASE_URL env the operator uses for its own
// app connection — same creds for the CLI path, no extra secret plumbing.
function operatorPgPassword(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return '';
  try {
    return new URL(url).password;
  } catch {
    return '';
  }
}

function execPsql(sql: string): string {
  try {
    const escaped = sql.replace(/"/g, '\\"');
    const pw = operatorPgPassword();
    return execSync(
      `kubectl exec -n ${PG_NAMESPACE} $(kubectl get pod -n ${PG_NAMESPACE} -l ${PG_POD_LABEL} -o jsonpath='{.items[0].metadata.name}') -- env PGPASSWORD='${pw}' psql -U ${OPERATOR_PG_USER} -d k3s_operator -h localhost -t -A -c "${escaped}"`,
      { encoding: 'utf-8', timeout: 15_000, maxBuffer: 1024 * 1024 },
    ).trim();
  } catch {
    return '';
  }
}

/** Check active connection count vs max_connections */
export async function checkPostgresConnections(): Promise<void> {
  const output = execPsql(
    "SELECT count(*) AS active, (SELECT setting::int FROM pg_settings WHERE name='max_connections') AS max FROM pg_stat_activity WHERE state IS NOT NULL",
  );
  if (!output) return;

  // Output format: "active|max"
  const [activeStr, maxStr] = output.split('|');
  const active = parseInt(activeStr ?? '0', 10);
  const max = parseInt(maxStr ?? '100', 10);

  if (active >= CONNECTION_THRESHOLD) {
    await ingestEvent({
      id: newEventId(),
      source: 'schedule',
      kind: 'postgres_connections_high',
      summary: `PostgreSQL connections: ${active}/${max} (threshold: ${CONNECTION_THRESHOLD})`,
      details: { active, max, threshold: CONNECTION_THRESHOLD, utilizationPct: Math.round((active / max) * 100) },
      timestamp: new Date(),
    });
  }
}

/** Check for long-running queries
 *
 * Excludes `walsender` backend_type. Those are CNPG physical replication sessions
 * (`START_REPLICATION ... SLOT "_cnpg_postgres_N"`) which are persistent streaming
 * connections — long duration is the design, not a symptom. Replication health is
 * tracked via `pg_stat_replication` (lag_bytes, state), not this watcher. CPU pegging
 * is covered by the `PodCPUHigh` Prometheus alert on the postgres pods.
 */
export async function checkPostgresLongQueries(): Promise<void> {
  const output = execPsql(
    `SELECT pid, now() - pg_stat_activity.query_start AS duration, state, backend_type, left(query, 200) AS query FROM pg_stat_activity WHERE (now() - pg_stat_activity.query_start) > interval '${LONG_QUERY_SECONDS} seconds' AND state != 'idle' AND backend_type = 'client backend' ORDER BY duration DESC LIMIT 5`,
  );
  if (!output) return;

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [pid, duration, state, backendType, query] = line.split('|');
    if (!pid) continue;

    await ingestEvent({
      id: newEventId(),
      source: 'schedule',
      kind: 'postgres_long_query',
      summary: `PostgreSQL long-running query (pid ${pid}): ${duration} in state ${state}`,
      details: { pid: parseInt(pid, 10), duration, state, backendType, query: query?.trim() },
      timestamp: new Date(),
    });
  }
}

/** Check database sizes approaching PVC capacity */
export async function checkPostgresDatabaseSize(): Promise<void> {
  const output = execPsql(
    "SELECT datname, pg_database_size(datname)/1024/1024 AS size_mb FROM pg_database WHERE datistemplate = false ORDER BY size_mb DESC",
  );
  if (!output) return;

  let totalMb = 0;
  const databases: Array<{ name: string; sizeMb: number }> = [];

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [name, sizeStr] = line.split('|');
    const sizeMb = parseInt(sizeStr?.trim() ?? '0', 10);
    if (name) databases.push({ name: name.trim(), sizeMb });
    totalMb += sizeMb;
  }

  if (totalMb >= DB_SIZE_WARNING_MB) {
    await ingestEvent({
      id: newEventId(),
      source: 'schedule',
      kind: 'postgres_disk_warning',
      summary: `PostgreSQL total size ${totalMb}MB approaching PVC limit (threshold: ${DB_SIZE_WARNING_MB}MB)`,
      details: { totalMb, thresholdMb: DB_SIZE_WARNING_MB, databases },
      timestamp: new Date(),
    });
  }
}

/** Check if postgres is accepting connections at all (basic liveness) */
export async function checkPostgresLiveness(): Promise<void> {
  try {
    const result = execSync(
      `kubectl exec -n ${PG_NAMESPACE} $(kubectl get pod -n ${PG_NAMESPACE} -l ${PG_POD_LABEL} -o jsonpath='{.items[0].metadata.name}') -- pg_isready -U postgres`,
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim();

    if (!result.includes('accepting connections')) {
      await ingestEvent({
        id: newEventId(),
        source: 'schedule',
        kind: 'postgres_not_ready',
        summary: `PostgreSQL is not accepting connections: ${result}`,
        details: { result },
        timestamp: new Date(),
      });
    }
  } catch {
    await ingestEvent({
      id: newEventId(),
      source: 'schedule',
      kind: 'postgres_unreachable',
      summary: 'PostgreSQL pod unreachable or pg_isready failed',
      details: {},
      timestamp: new Date(),
    });
  }
}

/** Run all PostgreSQL health checks */
export async function checkPostgresHealth(): Promise<void> {
  await checkPostgresLiveness();
  await checkPostgresConnections();
  await checkPostgresLongQueries();
  await checkPostgresDatabaseSize();
}
