/**
 * Working memory: in-process, current task context.
 * Cleared between tasks. Not persisted to database.
 */

interface WorkingContext {
  activeGoalId: string | null;
  conversationId: string | null;
  pendingApprovals: Map<string, PendingApproval>;
  taskNotes: string[];
}

interface PendingApproval {
  toolName: string;
  toolInput: Record<string, unknown>;
  description: string;
  requestedAt: Date;
}

let _context: WorkingContext = freshContext();

function freshContext(): WorkingContext {
  return {
    activeGoalId: null,
    conversationId: null,
    pendingApprovals: new Map(),
    taskNotes: [],
  };
}

export function getWorkingContext(): WorkingContext {
  return _context;
}

export function setActiveGoal(goalId: string | null): void {
  _context.activeGoalId = goalId;
}

export function setConversation(conversationId: string | null): void {
  _context.conversationId = conversationId;
}

export function addPendingApproval(id: string, approval: PendingApproval): void {
  _context.pendingApprovals.set(id, approval);
}

export function resolvePendingApproval(id: string): PendingApproval | undefined {
  const approval = _context.pendingApprovals.get(id);
  _context.pendingApprovals.delete(id);
  return approval;
}

export function addTaskNote(note: string): void {
  _context.taskNotes.push(note);
}

export function clearWorkingMemory(): void {
  _context = freshContext();
}

/** Summarize working memory for inclusion in agent context */
export function summarizeWorking(): string {
  const parts: string[] = [];
  if (_context.activeGoalId) {
    parts.push(`Active goal: ${_context.activeGoalId}`);
  }
  if (_context.pendingApprovals.size > 0) {
    parts.push(`Pending approvals: ${_context.pendingApprovals.size}`);
  }
  if (_context.taskNotes.length > 0) {
    parts.push(`Notes:\n${_context.taskNotes.map((n) => `- ${n}`).join('\n')}`);
  }
  return parts.join('\n');
}
