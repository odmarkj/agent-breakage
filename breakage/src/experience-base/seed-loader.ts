/**
 * Week-1 bootstrap: load real-incident postmortems from
 * breakage/experience-base/seed/*.yaml into the experience base.
 *
 * Idempotent via the upsert path. Safe to rerun after adding new
 * seed files.
 */

import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { upsertPostmortem } from './store.js';
import type { Postmortem } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SEED_DIR = resolve(__dirname, '../../experience-base/seed');

export async function loadSeed(): Promise<{ loaded: number; skipped: number }> {
  const files = (await readdir(SEED_DIR))
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();

  let loaded = 0;
  let skipped = 0;

  for (const file of files) {
    const path = resolve(SEED_DIR, file);
    const text = await readFile(path, 'utf8');
    let parsed: unknown;
    try {
      parsed = parseYaml(text);
    } catch (err) {
      console.error(`[seed] parse error in ${file}:`, err);
      skipped += 1;
      continue;
    }

    const p = parsed as Postmortem;
    if (!p || !p.incident_id) {
      console.error(`[seed] ${file} missing incident_id, skipping`);
      skipped += 1;
      continue;
    }

    await upsertPostmortem(p, { source: 'incident-log', rawYaml: text });
    console.log(`[seed] loaded ${basename(file)} (${p.incident_id}, outcome=${p.outcome})`);
    loaded += 1;
  }

  return { loaded, skipped };
}

// Invoked directly via `npm run seed` (Week 1+).
const isMain = process.argv[1] === __filename;
if (isMain) {
  loadSeed()
    .then(({ loaded, skipped }) => {
      console.log(`[seed] done. loaded=${loaded} skipped=${skipped}`);
      process.exit(skipped > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}
