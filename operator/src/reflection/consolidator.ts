import { getSql } from '../db.js';
import { getRecentEpisodes, recordEpisode } from '../memory/episodic.js';
import { getProvider } from '../provider/index.js';
import { cleanupOldSessions } from '../memory/session.js';
import { decayLearnings } from '../memory/learnings.js';
import { emit } from '../lib/events.js';
import { SYSTEM_AGGREGATE_ID } from '../types/events.js';

/**
 * Reflection/consolidation loop.
 * Runs periodically (nightly) to:
 * - Compress old events into episodic summaries
 * - Identify recurring patterns
 * - Suggest new heuristic rules
 * - Clean up stale data
 */

/** Consolidate recent events into episodic memories */
export async function consolidateEvents(): Promise<void> {
  const sql = getSql();

  // Get events from the last 24 hours that haven't been consolidated
  const events = await sql`
    SELECT * FROM events
    WHERE timestamp > NOW() - INTERVAL '24 hours'
    AND triage_decision NOT IN ('ignore')
    ORDER BY timestamp ASC
  `;

  if (events.length === 0) return;

  // Group events by source and kind for summarization
  type EventRow = Record<string, unknown>;
  const groups = new Map<string, EventRow[]>();
  for (const event of events) {
    const key = `${event.source}:${event.kind}`;
    const group = groups.get(key) ?? [];
    group.push(event as EventRow);
    groups.set(key, group);
  }

  // Summarize each group using a cheap LLM call
  const provider = getProvider('low');

  for (const [key, groupEvents] of groups) {
    if (groupEvents.length < 2) continue; // don't summarize single events

    const eventSummaries = groupEvents
      .map((e) => `- ${e.summary} (${e.triage_decision})`)
      .join('\n');

    try {
      const summary = await provider.classify(
        `Summarize these Kubernetes cluster events in one sentence:\n${eventSummaries}\n\nSummary:`,
      );

      await recordEpisode({
        title: `${key} events (${groupEvents.length} occurrences)`,
        summary,
        details: { eventCount: groupEvents.length, source: key },
        tags: [key.split(':')[0], key.split(':')[1]],
      });
    } catch {
      // LLM call failed, skip consolidation
    }
  }
}

/** Clean up old events (keep 7 days) */
export async function cleanupOldEvents(): Promise<void> {
  const sql = getSql();
  await sql`DELETE FROM events WHERE timestamp < NOW() - INTERVAL '7 days'`;
}

/** Full nightly consolidation routine */
export async function runNightlyConsolidation(): Promise<void> {
  await consolidateEvents();
  await cleanupOldEvents();
  await cleanupOldSessions();
  decayLearnings();
  emit(SYSTEM_AGGREGATE_ID, 'CONSOLIDATION_COMPLETED', {
    timestamp: new Date().toISOString(),
  });
}

let _timer: ReturnType<typeof setInterval> | null = null;

/** Start the nightly consolidation loop */
export function startConsolidation(intervalMs = 24 * 60 * 60 * 1000): void {
  // Run once on startup (after a delay to let things settle)
  setTimeout(() => {
    void runNightlyConsolidation().catch(() => {});
  }, 60_000);

  _timer = setInterval(() => {
    void runNightlyConsolidation().catch(() => {});
  }, intervalMs);
}

export function stopConsolidation(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
