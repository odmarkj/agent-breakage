import { getSql } from '../db.js';
import { emit } from '../lib/events.js';
import { SYSTEM_AGGREGATE_ID } from '../types/events.js';

/**
 * Episodic memory: past incidents and resolutions stored in the database.
 * Examples: "Last time lde-dash went OOM, increased memory limits from 512Mi to 1Gi"
 */

interface Episode {
  id: string;
  title: string;
  summary: string;
  details: Record<string, unknown>;
  tags: string[];
  createdAt: Date;
}

function newId(): string {
  return `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function recordEpisode(params: {
  title: string;
  summary: string;
  details?: Record<string, unknown>;
  tags?: string[];
}): Promise<string> {
  const sql = getSql();
  const id = newId();
  await sql`
    INSERT INTO episodic_memory (id, title, summary, details, tags)
    VALUES (${id}, ${params.title}, ${params.summary}, ${JSON.stringify(params.details ?? {})}, ${JSON.stringify(params.tags ?? [])})
  `;
  emit(SYSTEM_AGGREGATE_ID, 'EPISODE_RECORDED', { episodeId: id, title: params.title, tags: params.tags ?? [] });
  return id;
}

export async function searchEpisodes(query: string, limit = 10): Promise<Episode[]> {
  const sql = getSql();
  const pattern = `%${query}%`;
  const rows = await sql`
    SELECT * FROM episodic_memory
    WHERE title LIKE ${pattern} OR summary LIKE ${pattern} OR tags LIKE ${pattern}
    ORDER BY created_at DESC LIMIT ${limit}
  `;

  return rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    summary: r.summary as string,
    details: JSON.parse(r.details as string),
    tags: JSON.parse(r.tags as string),
    createdAt: new Date(r.created_at as string),
  }));
}

export async function getRecentEpisodes(limit = 5): Promise<Episode[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM episodic_memory ORDER BY created_at DESC LIMIT ${limit}
  `;

  return rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    summary: r.summary as string,
    details: JSON.parse(r.details as string),
    tags: JSON.parse(r.tags as string),
    createdAt: new Date(r.created_at as string),
  }));
}
