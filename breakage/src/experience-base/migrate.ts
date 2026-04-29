/**
 * Migration runner. Applies SQL files from
 * breakage/experience-base/migrations/*.sql in numeric order, once
 * each. Idempotent — rerunning is a no-op after the first run.
 *
 * Intentionally simple: tracks applied migrations in a tiny
 * `_breakage_migrations` table. Not using a migration library because
 * the scope is small and the project already has enough libraries.
 */

import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSql, closeSql } from '../lib/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATIONS_DIR = resolve(__dirname, '../../experience-base/migrations');

async function ensureMigrationsTable(): Promise<void> {
  const sql = getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS _breakage_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

async function appliedMigrations(): Promise<Set<string>> {
  const sql = getSql();
  const rows = await sql<{ name: string }[]>`SELECT name FROM _breakage_migrations`;
  return new Set(rows.map((r) => r.name));
}

async function runMigration(name: string, body: string): Promise<void> {
  const sql = getSql();
  // Wrap in a transaction; postgres.js `.unsafe()` allows arbitrary SQL
  // which is what we need for raw migration files.
  await sql.begin(async (tx) => {
    await tx.unsafe(body);
    await tx`INSERT INTO _breakage_migrations (name) VALUES (${name})`;
  });
}

export async function migrate(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await appliedMigrations();

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`[migrate] skip ${file} (already applied)`);
      continue;
    }
    const body = await readFile(resolve(MIGRATIONS_DIR, file), 'utf8');
    console.log(`[migrate] applying ${file}`);
    await runMigration(file, body);
    console.log(`[migrate] applied ${file}`);
  }
}

// When invoked directly via `npm run migrate`.
const isMain = process.argv[1] === __filename;
if (isMain) {
  migrate()
    .then(async () => {
      await closeSql();
      console.log('[migrate] done');
    })
    .catch(async (err) => {
      console.error('[migrate] failed:', err);
      await closeSql();
      process.exit(1);
    });
}
