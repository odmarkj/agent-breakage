import type { GoalStatus } from '../types.js';

export const EMILY_EVENT_TYPES = [
  // Goal lifecycle
  'GOAL_CREATED',
  'GOAL_APPROVED',
  'GOAL_ACTIVATED',
  'GOAL_EXECUTION_STARTED',
  'GOAL_ROUND_COMPLETED',
  'GOAL_COMPLETED',
  'GOAL_FAILED',
  'GOAL_CANCELLED',
  'GOAL_ESCALATED',

  // Tool execution
  'TOOL_PROPOSED',
  'TOOL_POLICY_EVALUATED',
  'TOOL_EXECUTED',
  'TOOL_FAILED',
  'TOOL_DENIED',
  'TOOL_APPROVAL_REQUESTED',
  'TOOL_APPROVAL_GRANTED',
  'TOOL_APPROVAL_DENIED',

  // Triage
  'EVENT_RECEIVED',
  'EVENT_HEURISTIC_EVALUATED',
  'EVENT_LLM_CLASSIFIED',
  'EVENT_TRIAGED',
  'EVENT_DEDUPLICATED',

  // Memory
  'ENTITY_FACT_ADDED',
  'ENTITY_FACT_UPDATED',
  'EPISODE_RECORDED',
  'LEARNING_EXTRACTED',
  'CONSOLIDATION_COMPLETED',

  // Feedback / self-analysis
  'FEEDBACK_ANALYSIS_STARTED',
  'FEEDBACK_ANALYSIS_COMPLETED',
  'FEEDBACK_ANALYSIS_FAILED',

  // System
  'SYSTEM_STARTUP',
  'SYSTEM_SHUTDOWN',
  'SLACK_MESSAGE_SENT',
  'SLACK_MESSAGE_FAILED',

  // Chat (interactive agent)
  'CHAT_STARTED',
  'CHAT_ROUND_COMPLETED',
  'CHAT_COMPLETED',
] as const;

export type EmilyEventType = (typeof EMILY_EVENT_TYPES)[number];

export interface GoalEvent {
  id: number;
  goalId: string;
  sequence: number;
  eventType: EmilyEventType;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface GoalSnapshot {
  goalId: string;
  currentState: GoalStatus;
  lastSequence: number;
  snapshot: Record<string, unknown>;
  updatedAt: Date;
}

/** Triage events use this synthetic aggregate (pre-goal) */
export const TRIAGE_AGGREGATE_ID = '_triage';

/** System lifecycle events */
export const SYSTEM_AGGREGATE_ID = '_system';

/** Feedback / self-analysis events (not tied to a single goal) */
export const FEEDBACK_AGGREGATE_ID = '_feedback';

/** Interactive chat sessions */
export function chatAggregateId(sessionId: string): string {
  return `chat_${sessionId}`;
}
