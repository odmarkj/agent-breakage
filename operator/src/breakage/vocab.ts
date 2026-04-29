/**
 * Loads the breakage framework's controlled root-cause vocabulary
 * and renders it as a system-prompt section. The vocab is the
 * single source of truth for what `primary_category` values Emily
 * can use in a postmortem — anything else scores 0 on the
 * diagnosed axis even when the prose is correct.
 *
 * The vocabulary file lives at
 * `<repo>/breakage/vocab/root-cause-categories.yaml` in dev and
 * at an explicit path set via OPERATOR_VOCAB_PATH in production
 * (where the operator is bundled and the breakage source tree
 * isn't alongside it).
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_PATHS = [
  // Explicit override first
  process.env.OPERATOR_VOCAB_PATH,
  // Container deploy: vocab shipped via the context ConfigMap
  '/app/context/root-cause-categories.yaml',
  // Dev: sibling breakage/ directory
  resolve(__dirname, '../../../breakage/vocab/root-cause-categories.yaml'),
].filter(Boolean) as string[];

interface VocabFile {
  version: number;
  categories: Array<{
    id: string;
    description: string;
  }>;
}

let _cached: VocabFile | null = null;

async function loadVocab(): Promise<VocabFile | null> {
  if (_cached) return _cached;
  for (const path of DEFAULT_PATHS) {
    try {
      const text = await readFile(path, 'utf8');
      _cached = parseYaml(text) as VocabFile;
      console.log(`[vocab] loaded ${_cached?.categories?.length ?? 0} categories from ${path}`);
      return _cached;
    } catch {
      continue;
    }
  }
  console.warn(`[vocab] no vocab file found; tried: ${DEFAULT_PATHS.join(', ')}`);
  return null;
}

/**
 * Render the vocabulary as a system-prompt section. Short
 * descriptions — Emily doesn't need the full rationale; she needs
 * to recognize which id fits the incident she's investigating.
 */
export async function renderVocabSection(): Promise<string> {
  const v = await loadVocab();
  if (!v) return '';
  const lines: string[] = [
    '## Root-cause vocabulary (required for postmortems)',
    '',
    'When you call `write_postmortem`, the `primary_category` field MUST be exactly one of the ids below. Using any other string — even a plausible synonym like "configuration-error" or "credential-issue" — scores 0 on the diagnosed axis because the scorer does exact-match comparison against ground_truth.',
    '',
    'If none of these categories fits the incident, pick the closest one AND add a short note in `what_did_not_work` proposing a new category + rationale. Human reviewers decide whether to expand the vocabulary.',
    '',
  ];
  for (const c of v.categories) {
    const firstLine = c.description.split('\n')[0].trim();
    lines.push(`- \`${c.id}\` — ${firstLine}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function _clearVocabCache(): void {
  _cached = null;
}
