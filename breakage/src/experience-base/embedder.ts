/**
 * Embedding pipeline for postmortems.
 *
 * Composes a retrieval key from the structured fields most relevant
 * to "is this past incident similar to what I'm seeing now" — symptom
 * signature, affected workload class, final diagnosis. Then embeds
 * that key string with the configured embedding provider.
 *
 * Provider abstraction is deliberately thin: Phase 1 ships Anthropic
 * Voyage (1536 dims). Swap providers via EMBEDDING_PROVIDER env and
 * update the migration's vector dim if the new provider differs.
 *
 * NB: We embed the *retrieval key*, not the full postmortem. A
 * postmortem has ~2-5KB of text; embedding just the key keeps the
 * vector focused on "what pattern is this" and avoids noise from
 * long diagnostic prose.
 */

import type { Postmortem } from '../types/index.js';

// Default: BAAI/bge-m3 via the in-cluster text-embeddings-inference
// pod (services/embeddings/). Reached from within the production
// cluster at embeddings.platform-embeddings.svc.cluster.local, or
// externally at https://embeddings.ldex.co/embeddings. 1024-dim
// matches the migration's vector column.
const EMBEDDING_DIM = Number(process.env.BREAKAGE_EMBEDDING_DIM ?? 1024);
const EMBEDDING_MODEL = process.env.BREAKAGE_EMBEDDING_MODEL ?? 'BAAI/bge-m3';

export interface Embedder {
  embed(text: string): Promise<number[]>;
  readonly dim: number;
}

// ── Retrieval key composition ───────────────────────────────────────

/**
 * Compose the string that gets embedded. Stable across postmortem
 * schema evolutions — if we add fields, we update this function
 * and re-embed the corpus in a new migration.
 */
export function retrievalKey(p: Postmortem): string {
  const parts = [
    `symptom: ${p.final_diagnosis}`,
    `primary_category: ${p.primary_category}`,
    p.secondary_categories.length
      ? `secondary_categories: ${p.secondary_categories.join(', ')}`
      : '',
    `actions: ${p.actions_taken.map((a) => a.tool).join(' → ')}`,
    p.what_did_not_work.length
      ? `what_did_not_work: ${p.what_did_not_work.join(' | ')}`
      : '',
    `outcome: ${p.outcome}`,
  ].filter(Boolean);
  return parts.join('\n');
}

// ── OpenAI-compatible embedder (TEI / VLLM / OpenAI / Voyage) ─────
//
// The production path is the in-cluster TEI pod at
// services/embeddings/ which exposes BAAI/bge-m3 at the same
// /embeddings path that OpenAI uses. This class is endpoint- and
// model-agnostic — set BREAKAGE_EMBEDDING_URL +
// BREAKAGE_EMBEDDING_API_KEY + BREAKAGE_EMBEDDING_MODEL to swap.
//
// Named "OpenAICompatibleEmbedder" because the wire format is OpenAI;
// the backing server is TEI today.

export class OpenAICompatibleEmbedder implements Embedder {
  readonly dim = EMBEDDING_DIM;
  private readonly url: string;
  private readonly model: string;
  private readonly apiKey: string | null;

  constructor(opts: { url?: string; model?: string; apiKey?: string } = {}) {
    this.url =
      opts.url
      ?? process.env.BREAKAGE_EMBEDDING_URL
      // Default to the public Ingress — works from both the orch VM
      // (breakage-framework dev) and any other external consumer.
      // Override via BREAKAGE_EMBEDDING_URL to
      // http://embeddings.platform-embeddings.svc.cluster.local/embeddings
      // when running in-cluster.
      ?? 'https://embeddings.ldex.co/embeddings';
    this.model = opts.model ?? EMBEDDING_MODEL;
    this.apiKey = opts.apiKey ?? process.env.BREAKAGE_EMBEDDING_API_KEY ?? null;
  }

  async embed(text: string): Promise<number[]> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;

    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.model, input: text }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Embedding ${this.url} ${res.status}: ${body}`);
    }

    const data = (await res.json()) as { data?: Array<{ embedding: number[] }>; embedding?: number[] };
    const vector = data.data?.[0]?.embedding ?? data.embedding;
    if (!vector) {
      throw new Error(`Embedding ${this.url} returned no vector: ${JSON.stringify(data).slice(0, 200)}`);
    }
    if (vector.length !== this.dim) {
      throw new Error(
        `Embedding dim mismatch: got ${vector.length}, expected ${this.dim}. ` +
          `Set BREAKAGE_EMBEDDING_DIM to match your provider, and make sure the ` +
          `postmortems table's embedding column dimension matches.`,
      );
    }
    return vector;
  }
}

// ── Deterministic fallback for dev / offline ────────────────────────
//
// Produces a repeatable hash-based vector. Useful for:
//   - unit tests that shouldn't hit the network
//   - dev runs without an API key
// NOT useful for real retrieval quality — similarity scores are noise.

export class DeterministicEmbedder implements Embedder {
  readonly dim = EMBEDDING_DIM;
  async embed(text: string): Promise<number[]> {
    // Simple DJB2 hash seeded across the vector space. Gives
    // reproducible but low-quality embeddings.
    const vec = new Array<number>(this.dim).fill(0);
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) + h + text.charCodeAt(i)) | 0;
      vec[Math.abs(h) % this.dim] += 1;
    }
    // Normalize to unit length for cosine distance.
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}

// ── Default factory ─────────────────────────────────────────────────

export function defaultEmbedder(): Embedder {
  if (process.env.BREAKAGE_EMBEDDER === 'deterministic') {
    return new DeterministicEmbedder();
  }
  // OpenAI-compatible is the default. Targets the in-cluster TEI
  // pod at services/embeddings/ via its public Ingress; works
  // against any TEI / VLLM / OpenAI / Voyage server that speaks
  // /v1/embeddings. Configure via BREAKAGE_EMBEDDING_URL +
  // BREAKAGE_EMBEDDING_MODEL + BREAKAGE_EMBEDDING_DIM.
  return new OpenAICompatibleEmbedder();
}
