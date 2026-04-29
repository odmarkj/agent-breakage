import type Anthropic from '@anthropic-ai/sdk';

// ── Chat types ──────────────────────────────────────────────────────

export interface ChatRequest {
  message: string;
  history?: ChatMessage[];
  conversationId?: string;
  userRole: 'admin' | 'user';
  userId: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ── SSE events sent to clients (Slack, CLI, web) ────────────────────

export type SSEEvent =
  | { type: 'token'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_call'; toolName: string; toolInput: Record<string, unknown> }
  | { type: 'tool_result'; toolName: string; result: unknown }
  | { type: 'approval_required'; toolName: string; description: string; toolInput: Record<string, unknown> }
  | { type: 'done' }
  | { type: 'error'; content: string };

// ── Tool system ─────────────────────────────────────────────────────

/** Tool tier determines confirmation behavior:
 *  1 = read-only, auto-execute
 *  2 = write with audit logging, auto-execute
 *  3 = destructive, requires human approval
 */
export type ToolTier = 1 | 2 | 3;

/**
 * Reversibility is a per-tool scalar Emily consults at inference speed
 * when choosing among candidate actions. Independent of tier gating:
 * tier gates human/synthetic approval; reversibility informs Emily's
 * own risk reasoning.
 *
 * Canonical buckets:
 *   0.0 — trivially reversible (read-only)
 *   0.3 — reversible-with-snapshot (patch, scale, restart — auto-reverted
 *         by the breakage speculative-execution controller)
 *   0.7 — reversible-with-effort (rebuild from backup, manual restoration;
 *         arbitrary shell/exec that could have unpredictable side effects)
 *   1.0 — irreversible (secret content write, delete, arbitrary SQL,
 *         Helm ops that span multiple resources)
 *
 * Known limitation: tool-only, not tool × target × environment. A patch
 * on a 10-replica production Deployment is effectively a different
 * reversibility class than the same patch on a 1-replica dev deployment.
 * See breakage/planning for Phase-2+ refinement.
 */
export type Reversibility = number;

export interface ToolDefinition {
  name: string;
  description: string;
  tier: ToolTier;
  /** See Reversibility type above. Canonical values: 0.0, 0.3, 0.7, 1.0. */
  reversibility: Reversibility;
  adminOnly: boolean;
  inputSchema: Anthropic.Tool['input_schema'];
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

// ── Provider abstraction ────────────────────────────────────────────

export type CostTier = 'low' | 'medium' | 'high';

export interface ChatParams {
  system: string;
  messages: ProviderMessage[];
  tools?: ProviderTool[];
  maxTokens?: number;
}

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string | ProviderContentBlock[];
}

export type ProviderContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface ProviderTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface StreamEvent {
  type: 'text' | 'tool_use' | 'message_end';
  text?: string;
  toolUse?: { id: string; name: string; input: Record<string, unknown> };
  stopReason?: string;
  content?: ProviderContentBlock[];
}

export interface LLMProvider {
  chat(params: ChatParams): AsyncGenerator<StreamEvent>;
  classify(prompt: string): Promise<string>;
  readonly costTier: CostTier;
  readonly name: string;
}

// ── Goal system ─────────────────────────────────────────────────────

export type GoalStatus =
  | 'proposed'
  | 'approved'
  | 'active'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Goal {
  id: string;
  title: string;
  context: string;
  objective: string;
  riskClass: 'low' | 'medium' | 'high';
  approvalRequired: boolean;
  status: GoalStatus;
  toolsUsed: string[];
  createdAt: Date;
  completedAt: Date | null;
  outcome: string | null;
}

// ── Triage ──────────────────────────────────────────────────────────

export type TriageDecision = 'ignore' | 'log' | 'routine' | 'urgent' | 'escalate';

export interface ClusterEvent {
  id: string;
  source: 'kubernetes' | 'github' | 'slack' | 'schedule' | 'alertmanager';
  kind: string;
  summary: string;
  details: Record<string, unknown>;
  timestamp: Date;
}

// ── Audit ───────────────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  timestamp: Date;
  userId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolTier: ToolTier;
  result: unknown;
  goalId?: string;
}
