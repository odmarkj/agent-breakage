/**
 * k-NN retrieval over the postmortems table.
 *
 * Returns both resolved and regressed postmortems with outcome labels
 * intact. Excluding failed-outcome postmortems would lose valuable
 * counterexample signal; preferential weighting is vague. Explicit
 * labeling is cleanest — the caller (Emily's agent loop) frames
 * retrieved examples as positive exemplars or counterexamples based
 * on the label.
 *
 * Distance metric: cosine. Smaller = more similar. The migration
 * creates an ivfflat index with `vector_cosine_ops`.
 */

import { getSql } from '../lib/db.js';
import { defaultEmbedder, retrievalKey, type Embedder } from './embedder.js';
import type { Postmortem, Outcome } from '../types/index.js';

export interface RetrievalResult {
  id: string;
  /** Cosine distance. 0 = identical, 2 = opposite. */
  distance: number;
  postmortem: Postmortem;
  /** Duplicated here for caller convenience; also inside `postmortem.outcome`. */
  outcome: Outcome;
  /** Where this postmortem came from. */
  source: 'incident-log' | 'scenario' | 'production';
}

export interface RetrievalQuery {
  /**
   * The query text to embed. Typically the current event's symptom
   * signature + initial hypothesis. If you have a partial Postmortem
   * shape, pass it through retrievalKey() first.
   */
  text: string;
  /** Top-k. Default 3 — plan §10. */
  k?: number;
  /**
   * Optional category filter. If the caller has a high-confidence
   * prior on what category this incident is, narrow retrieval to
   * that category + its close relatives. Leave empty to retrieve
   * across all categories.
   */
  categories?: string[];
  /**
   * Optional source filter. Defaults to all sources. Use
   * ['incident-log', 'production'] during scenario runs to prevent
   * the scenario's own growing corpus from dominating retrieval
   * against older real experience.
   */
  sources?: Array<'incident-log' | 'scenario' | 'production'>;
  /**
   * Optional cosine-distance upper bound. Results with distance
   * strictly greater than this value are filtered out BEFORE being
   * returned — they never reach Emily's prompt.
   *
   * Rationale: the 2026-04-24 controlled measurement found retrieval
   * actively harmful on scenarios with sparse near-neighbors. The
   * top-k result would be semantically nearby but mechanistically
   * wrong (a cpu-throttling scenario receiving OOM postmortems as
   * top hits, for instance). A threshold turns those into empty
   * result sets, which Emily treats as "no prior precedent" rather
   * than misleading precedent.
   *
   * If unset at the query level, falls back to the
   * BREAKAGE_RETRIEVAL_MAX_DISTANCE env var, then to null (no filter).
   */
  maxDistance?: number;
  /**
   * Optional candidate-pool cap. Limits the SQL query to the top-N
   * nearest postmortems before any threshold filtering or k-cap.
   * Used to simulate "what if the corpus only had N near-neighbors
   * for this query" — central to the corpus-density sweep
   * experiment (Phase 0).
   *
   * When poolCap < k, retrieval will return at most poolCap rows.
   * When poolCap >= k, retrieval pulls poolCap candidates, applies
   * threshold filter, then slices to top-k.
   *
   * If unset at the query level, falls back to the
   * BREAKAGE_RETRIEVAL_POOL_CAP env var, then to null (use k).
   */
  poolCap?: number;
}

/**
 * Run a k-NN query. Embeds the query text, then returns the top-k
 * most-similar postmortems with full metadata.
 */
export async function retrieve(
  query: RetrievalQuery,
  embedder: Embedder = defaultEmbedder(),
): Promise<RetrievalResult[]> {
  const k = query.k ?? 3;
  const poolCap = resolvePoolCap(query.poolCap);
  // SQL pulls poolCap candidates if a cap is set, else just k.
  // After SQL we apply maxDistance filter + slice to k.
  const sqlLimit = poolCap !== null ? poolCap : k;
  const vec = await embedder.embed(query.text);
  const vecStr = `[${vec.join(',')}]`;

  const sql = getSql();

  // pgvector's `<=>` operator is cosine distance (with
  // vector_cosine_ops index). Order ascending to get nearest-first.
  let rows;
  if (query.categories && query.categories.length > 0 && query.sources && query.sources.length > 0) {
    rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, scenario_id, detected_at, final_diagnosis, primary_category,
             secondary_categories, confidence, actions_taken, fix_applied,
             what_did_not_work, time_to_diagnose_s, time_to_fix_s,
             side_effects_observed, retrieval_consulted, retrieval_used,
             outcome, source,
             (embedding <=> ${vecStr}::vector) AS distance
        FROM postmortems
       WHERE embedding IS NOT NULL
         AND primary_category = ANY(${query.categories})
         AND source = ANY(${query.sources})
       ORDER BY embedding <=> ${vecStr}::vector
       LIMIT ${sqlLimit}
    `;
  } else if (query.categories && query.categories.length > 0) {
    rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, scenario_id, detected_at, final_diagnosis, primary_category,
             secondary_categories, confidence, actions_taken, fix_applied,
             what_did_not_work, time_to_diagnose_s, time_to_fix_s,
             side_effects_observed, retrieval_consulted, retrieval_used,
             outcome, source,
             (embedding <=> ${vecStr}::vector) AS distance
        FROM postmortems
       WHERE embedding IS NOT NULL
         AND primary_category = ANY(${query.categories})
       ORDER BY embedding <=> ${vecStr}::vector
       LIMIT ${sqlLimit}
    `;
  } else if (query.sources && query.sources.length > 0) {
    rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, scenario_id, detected_at, final_diagnosis, primary_category,
             secondary_categories, confidence, actions_taken, fix_applied,
             what_did_not_work, time_to_diagnose_s, time_to_fix_s,
             side_effects_observed, retrieval_consulted, retrieval_used,
             outcome, source,
             (embedding <=> ${vecStr}::vector) AS distance
        FROM postmortems
       WHERE embedding IS NOT NULL
         AND source = ANY(${query.sources})
       ORDER BY embedding <=> ${vecStr}::vector
       LIMIT ${sqlLimit}
    `;
  } else {
    rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, scenario_id, detected_at, final_diagnosis, primary_category,
             secondary_categories, confidence, actions_taken, fix_applied,
             what_did_not_work, time_to_diagnose_s, time_to_fix_s,
             side_effects_observed, retrieval_consulted, retrieval_used,
             outcome, source,
             (embedding <=> ${vecStr}::vector) AS distance
        FROM postmortems
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> ${vecStr}::vector
       LIMIT ${sqlLimit}
    `;
  }

  const maxDistance = resolveMaxDistance(query.maxDistance);
  let results = rows.map((r) => rowToResult(r));
  if (maxDistance !== null) {
    results = results.filter((r) => r.distance <= maxDistance);
  }
  // When poolCap is set, the SQL pulled poolCap candidates; cap the
  // post-filter result set at k. When poolCap is unset the SQL
  // already capped at k, so this slice is a no-op.
  if (results.length > k) {
    results = results.slice(0, k);
  }
  return results;
}

function resolveMaxDistance(queryLevel: number | undefined): number | null {
  if (typeof queryLevel === 'number' && Number.isFinite(queryLevel)) return queryLevel;
  const envVal = process.env.BREAKAGE_RETRIEVAL_MAX_DISTANCE;
  if (envVal !== undefined && envVal !== '') {
    const n = Number(envVal);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function resolvePoolCap(queryLevel: number | undefined): number | null {
  if (typeof queryLevel === 'number' && Number.isFinite(queryLevel) && queryLevel > 0) {
    return Math.floor(queryLevel);
  }
  const envVal = process.env.BREAKAGE_RETRIEVAL_POOL_CAP;
  if (envVal !== undefined && envVal !== '') {
    const n = Number(envVal);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}

/**
 * Convenience: retrieve based on a partial postmortem (uses the same
 * key composer that the embedder uses for stored rows).
 */
export async function retrieveSimilarTo(
  partial: Postmortem,
  opts: Omit<RetrievalQuery, 'text'> = {},
  embedder?: Embedder,
): Promise<RetrievalResult[]> {
  return retrieve({ ...opts, text: retrievalKey(partial) }, embedder);
}

// ── Row → result mapping ────────────────────────────────────────────

function rowToResult(r: Record<string, unknown>): RetrievalResult {
  const postmortem: Postmortem = {
    scenario_id: (r.scenario_id as string | null) ?? null,
    incident_id: r.id as string,
    detected_at: (r.detected_at as Date).toISOString(),
    final_diagnosis: r.final_diagnosis as string,
    primary_category: r.primary_category as string,
    secondary_categories: (r.secondary_categories as string[]) ?? [],
    confidence: r.confidence as number,
    actions_taken: r.actions_taken as Postmortem['actions_taken'],
    fix_applied: r.fix_applied as string,
    what_did_not_work: (r.what_did_not_work as string[]) ?? [],
    time_to_diagnose_s: r.time_to_diagnose_s as number,
    time_to_fix_s: r.time_to_fix_s as number,
    side_effects_observed: (r.side_effects_observed as string[]) ?? [],
    retrieval_consulted: (r.retrieval_consulted as string[]) ?? [],
    retrieval_used: (r.retrieval_used as string[]) ?? [],
    outcome: r.outcome as Outcome,
  };
  return {
    id: r.id as string,
    distance: r.distance as number,
    postmortem,
    outcome: r.outcome as Outcome,
    source: r.source as RetrievalResult['source'],
  };
}
