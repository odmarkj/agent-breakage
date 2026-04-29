import type { Goal, GoalStatus } from '../types.js';

/** Valid state transitions for the goal state machine */
const VALID_TRANSITIONS: Record<GoalStatus, GoalStatus[]> = {
  proposed: ['approved', 'cancelled'],
  approved: ['active', 'cancelled'],
  active: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: GoalStatus, to: GoalStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminal(status: GoalStatus): boolean {
  return VALID_TRANSITIONS[status]?.length === 0;
}

export function newGoalId(): string {
  return `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createGoal(params: {
  title: string;
  objective: string;
  context?: string;
  riskClass?: Goal['riskClass'];
  approvalRequired?: boolean;
}): Goal {
  return {
    id: newGoalId(),
    title: params.title,
    context: params.context ?? '',
    objective: params.objective,
    riskClass: params.riskClass ?? 'low',
    approvalRequired: params.approvalRequired ?? false,
    status: 'proposed',
    toolsUsed: [],
    createdAt: new Date(),
    completedAt: null,
    outcome: null,
  };
}
