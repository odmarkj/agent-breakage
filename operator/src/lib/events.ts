import { getSql } from '../db.js';
import { EventStore } from './eventStore.js';
import type { EmilyEventType } from '../types/events.js';

let _eventStore: EventStore | null = null;

export function getEventStore(): EventStore {
  if (!_eventStore) {
    _eventStore = new EventStore(getSql());
  }
  return _eventStore;
}

/**
 * Fire-and-forget event emission.
 * Use this for non-critical events where failure shouldn't block execution.
 * For terminal events (GOAL_COMPLETED, GOAL_FAILED), use await getEventStore().append() directly.
 */
export function emit(
  goalId: string,
  eventType: EmilyEventType,
  payload: Record<string, unknown>,
  actor?: string,
): void {
  getEventStore()
    .append(goalId, eventType, payload, actor)
    .catch((err) => {
      console.error(`[EventStore] Failed to emit ${eventType} for ${goalId}:`, err);
    });
}
