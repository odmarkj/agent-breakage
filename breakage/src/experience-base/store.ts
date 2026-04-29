/**
 * Postmortem persistence. One upsert path that handles seed YAMLs,
 * scenario runs, and production incidents — differentiated by the
 * `source` column.
 *
 * Embeddings are computed here rather than at retrieval time so
 * retrieval stays cheap and deterministic.
 */

import type postgres from 'postgres';
import { getSql } from '../lib/db.js';
import { defaultEmbedder, retrievalKey, type Embedder } from './embedder.js';
import type { Postmortem } from '../types/index.js';

export type PostmortemSource = 'incident-log' | 'scenario' | 'production';

export interface UpsertOptions {
  source: PostmortemSource;
  /** Original YAML text for auditability. Optional. */
  rawYaml?: string;
  /** Override the default embedder (e.g., for tests). */
  embedder?: Embedder;
  /**
   * Scenario-run observations the orchestrator computes: score,
   * detector state, retrieval-used derivation, ran_at timestamp.
   * Persisted as JSONB for scorecard reports.
   */
  runMetadata?: Record<string, unknown>;
}

export async function upsertPostmortem(
  p: Postmortem,
  opts: UpsertOptions,
): Promise<void> {
  const embedder = opts.embedder ?? defaultEmbedder();
  // Graceful degradation: if the embedder is unreachable (VLLM
  // transient timeout, Anthropic API rate limit, etc.), persist
  // the postmortem without a vector rather than losing the row.
  // The row won't be retrievable until re-embedded, but Emily's
  // diagnosis + scoring data survives. Run `npm run reembed` to
  // backfill missing vectors later.
  let vecStr: string | null = null;
  try {
    const vec = await embedder.embed(retrievalKey(p));
    vecStr = `[${vec.join(',')}]`;
  } catch (err) {
    console.warn(`[upsertPostmortem] embedder failed, storing without vector: ${(err as Error).message}`);
  }

  const sql = getSql();
  await sql`
    INSERT INTO postmortems (
      id, scenario_id, detected_at, final_diagnosis, primary_category,
      secondary_categories, confidence, actions_taken, fix_applied,
      what_did_not_work, time_to_diagnose_s, time_to_fix_s,
      side_effects_observed, retrieval_consulted, retrieval_used,
      outcome, source, embedding, raw_yaml, run_metadata
    ) VALUES (
      ${p.incident_id},
      ${p.scenario_id},
      ${p.detected_at}::timestamptz,
      ${p.final_diagnosis},
      ${p.primary_category},
      ${p.secondary_categories},
      ${p.confidence},
      ${sql.json(p.actions_taken as unknown as postgres.JSONValue)},
      ${p.fix_applied},
      ${p.what_did_not_work},
      ${p.time_to_diagnose_s},
      ${p.time_to_fix_s},
      ${p.side_effects_observed},
      ${p.retrieval_consulted},
      ${p.retrieval_used},
      ${p.outcome},
      ${opts.source},
      ${vecStr === null ? null : sql`${vecStr}::vector`},
      ${opts.rawYaml ?? null},
      ${opts.runMetadata ? sql.json(opts.runMetadata as postgres.JSONValue) : null}
    )
    ON CONFLICT (id) DO UPDATE SET
      final_diagnosis = EXCLUDED.final_diagnosis,
      primary_category = EXCLUDED.primary_category,
      secondary_categories = EXCLUDED.secondary_categories,
      confidence = EXCLUDED.confidence,
      actions_taken = EXCLUDED.actions_taken,
      fix_applied = EXCLUDED.fix_applied,
      what_did_not_work = EXCLUDED.what_did_not_work,
      time_to_diagnose_s = EXCLUDED.time_to_diagnose_s,
      time_to_fix_s = EXCLUDED.time_to_fix_s,
      side_effects_observed = EXCLUDED.side_effects_observed,
      retrieval_consulted = EXCLUDED.retrieval_consulted,
      retrieval_used = EXCLUDED.retrieval_used,
      outcome = EXCLUDED.outcome,
      source = EXCLUDED.source,
      embedding = EXCLUDED.embedding,
      raw_yaml = EXCLUDED.raw_yaml,
      run_metadata = EXCLUDED.run_metadata
  `;
}
