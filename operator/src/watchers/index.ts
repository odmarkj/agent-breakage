import type { ClusterEvent } from '../types.js';
import { applyHeuristicRules, cleanupState } from '../triage/rules.js';
import { classifyEvent } from '../triage/classifier.js';
import { getSql } from '../db.js';
import { emit } from '../lib/events.js';
import { TRIAGE_AGGREGATE_ID } from '../types/events.js';

type EventHandler = (event: ClusterEvent, decision: string) => void | Promise<void>;

let _handler: EventHandler | null = null;
let _cleanupInterval: ReturnType<typeof setInterval> | null = null;

/** Register the handler that will process triaged events */
export function onTriagedEvent(handler: EventHandler): void {
  _handler = handler;
}

/**
 * Ingest a raw event from any watcher.
 * Runs through heuristic triage, then LLM classifier if needed.
 * Records the event and decision in the database.
 */
export async function ingestEvent(event: ClusterEvent): Promise<void> {
  // Step 1: Heuristic rules (free, no LLM)
  let decision = applyHeuristicRules(event);

  if (decision !== null) {
    emit(TRIAGE_AGGREGATE_ID, 'EVENT_HEURISTIC_EVALUATED', {
      eventId: event.id,
      source: event.source,
      kind: event.kind,
      summary: event.summary,
      decision,
    });
  }

  // Step 2: If heuristics didn't decide, classify with Haiku
  if (decision === null) {
    decision = await classifyEvent(event);
    emit(TRIAGE_AGGREGATE_ID, 'EVENT_LLM_CLASSIFIED', {
      eventId: event.id,
      source: event.source,
      kind: event.kind,
      summary: event.summary,
      decision,
    });
  }

  // Step 3: Record event + decision
  const sql = getSql();
  await sql`
    INSERT INTO events (id, source, kind, summary, details, triage_decision, timestamp)
    VALUES (${event.id}, ${event.source}, ${event.kind}, ${event.summary}, ${JSON.stringify(event.details)}, ${decision}, ${event.timestamp.toISOString()})
  `;

  emit(TRIAGE_AGGREGATE_ID, 'EVENT_TRIAGED', {
    eventId: event.id,
    source: event.source,
    kind: event.kind,
    decision,
  });

  // Step 4: Dispatch to handler if actionable
  if (decision !== 'ignore' && _handler) {
    await _handler(event, decision);
  }
}

/** Start periodic cleanup of triage state */
export function startWatcherCleanup(): void {
  _cleanupInterval = setInterval(cleanupState, 5 * 60 * 1000); // every 5 min
}

export function stopWatcherCleanup(): void {
  if (_cleanupInterval) {
    clearInterval(_cleanupInterval);
    _cleanupInterval = null;
  }
}

/** Generate a unique event ID */
export function newEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
