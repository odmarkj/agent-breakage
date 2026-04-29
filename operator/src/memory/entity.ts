import { getSql } from '../db.js';
import { emit } from '../lib/events.js';
import { SYSTEM_AGGREGATE_ID } from '../types/events.js';

/**
 * Entity memory: per-service/namespace facts stored in the database.
 * Examples: "lde-dash uses port 3000", "publisher-reviews MySQL has a slow query on reviews table"
 */

interface EntityFact {
  id: string;
  entityType: string;
  entityName: string;
  fact: string;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

function newId(): string {
  return `ent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function addEntityFact(entityType: string, entityName: string, fact: string, source = 'operator'): Promise<string> {
  const sql = getSql();
  const id = newId();
  await sql`
    INSERT INTO entity_memory (id, entity_type, entity_name, fact, source)
    VALUES (${id}, ${entityType}, ${entityName}, ${fact}, ${source})
  `;
  emit(SYSTEM_AGGREGATE_ID, 'ENTITY_FACT_ADDED', { entityType, entityName, fact, source });
  return id;
}

export async function getEntityFacts(entityType: string, entityName: string): Promise<EntityFact[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM entity_memory WHERE entity_type = ${entityType} AND entity_name = ${entityName} ORDER BY updated_at DESC
  `;

  return rows.map((r) => ({
    id: r.id as string,
    entityType: r.entity_type as string,
    entityName: r.entity_name as string,
    fact: r.fact as string,
    source: r.source as string,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  }));
}

export async function searchEntityFacts(query: string): Promise<EntityFact[]> {
  const sql = getSql();
  const pattern = `%${query}%`;
  const rows = await sql`
    SELECT * FROM entity_memory WHERE fact LIKE ${pattern} OR entity_name LIKE ${pattern} ORDER BY updated_at DESC LIMIT 20
  `;

  return rows.map((r) => ({
    id: r.id as string,
    entityType: r.entity_type as string,
    entityName: r.entity_name as string,
    fact: r.fact as string,
    source: r.source as string,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  }));
}

export async function updateEntityFact(id: string, fact: string): Promise<void> {
  const sql = getSql();
  await sql`UPDATE entity_memory SET fact = ${fact}, updated_at = NOW() WHERE id = ${id}`;
  emit(SYSTEM_AGGREGATE_ID, 'ENTITY_FACT_UPDATED', { id, fact });
}

export async function deleteEntityFact(id: string): Promise<void> {
  const sql = getSql();
  await sql`DELETE FROM entity_memory WHERE id = ${id}`;
}
