import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChatRequest, SSEEvent, ToolDefinition } from './types.js';
import { getToolsForRole } from './tools/index.js';
import { logToolExecution } from './audit.js';
import { evaluatePolicy, isBusinessHours } from './policies/rules.js';
import { buildBreakageSections } from './breakage/prompt-sections.js';
import { executeTierTwoWithSpecExec } from './breakage/speculative.js';
import { requestSyntheticApproval } from './breakage/synthetic-approval.js';
import { isSyntheticApprovalEnabled } from './breakage/synthetic-approval.js';

const client = new Anthropic();

const MODEL = process.env.OPERATOR_MODEL ?? 'claude-sonnet-4-20250514';
const MAX_TOKENS = 8192;
// Bumped from 20 to accommodate investigations that need a
// thorough read-phase before acting. Phase-1 scenarios routinely
// hit the old cap before Emily could call write_postmortem.
const MAX_TOOL_ROUNDS = Number(process.env.OPERATOR_MAX_TOOL_ROUNDS ?? 30);

/** Load cluster context from context/ directory */
let _clusterContext: string | null = null;
function loadClusterContext(): string {
  if (_clusterContext !== null) return _clusterContext;
  const contextDir = process.env.CONTEXT_DIR ?? resolve(process.cwd(), '..', 'context');
  const files = ['cluster.md', 'services.md', 'sops.md'];
  const parts: string[] = [];

  for (const file of files) {
    try {
      parts.push(readFileSync(resolve(contextDir, file), 'utf-8'));
    } catch {
      // file doesn't exist yet, skip
    }
  }

  _clusterContext = parts.join('\n\n');
  return _clusterContext;
}

async function buildSystemPrompt(request: ChatRequest): Promise<string> {
  const parts: string[] = [];

  const clusterContext = loadClusterContext();
  if (clusterContext) {
    parts.push(`## Cluster Context\n${clusterContext}\n`);
  }

  // Shared breakage-framework sections (retrieval + playbook + vocab
  // + synthetic-approval note). Identical rendering as the
  // autonomous goal executor — see operator/src/breakage/prompt-sections.ts.
  const breakage = await buildBreakageSections({ query: request.message });
  if (breakage.text) parts.push(breakage.text);

  parts.push(`## Your Role
You are the K3S cluster operator — an always-on AI agent managing a Kubernetes cluster. You have direct access to kubectl, helm, databases, and infrastructure through your tools.

## Guidelines
- Be concise and helpful. Lead with actions, not explanations.
- When asked to do something, DO IT — use your tools directly. Never suggest commands for the user to run manually.
- When asked to inspect the cluster, use kubectl tools and present results clearly.
- Always log your reasoning for non-trivial operations.
- When you don't know which namespace or resource name to use, use kubectl_get to discover it first.
- The user's role is "${request.userRole}". ${request.userRole === 'admin' ? 'They have full system access.' : 'They have read access only.'}

## Approval Flow
Tier 3 tools (kubectl_apply, kubectl_delete, kubectl_rollout_restart, kubectl_rollout_undo, helm_upgrade, helm_rollback) have a built-in approval gate — when you call them, the system automatically prompts the user. So just call the tool directly; do NOT ask permission first or suggest the command. The approval flow handles safety for you.

## Natural Language Understanding
Users will give you informal commands like "restart lde-dash" or "scale the workers". You should:
1. Map informal service names to their actual Kubernetes resources using kubectl_get if needed
2. Then immediately execute the requested action using the appropriate tool
3. Report what happened after execution
`);

  return parts.join('\n');
}

function getAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

/**
 * Run the agent loop: send message to Claude, handle tool calls, repeat until done.
 * Yields SSE events as they occur.
 *
 * For Tier 3 tools, the loop pauses and yields an approval_required event.
 * The stream ends, and the user's approval/denial comes as a follow-up request.
 */
export async function* runAgent(
  request: ChatRequest,
): AsyncGenerator<SSEEvent> {
  const tools = getToolsForRole(request.userRole);
  const systemPrompt = await buildSystemPrompt(request);
  const anthropicTools = getAnthropicTools(tools);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const messages: Anthropic.MessageParam[] = [];

  if (request.history) {
    for (const msg of request.history.slice(-20)) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  messages.push({ role: 'user', content: request.message });

  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds++;

    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages,
      tools: anthropicTools,
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield { type: 'token', content: event.delta.text };
      }
    }

    const finalMessage = await stream.finalMessage();
    const stopReason = finalMessage.stop_reason;

    const toolUseBlocks = finalMessage.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    if (toolUseBlocks.length === 0 || stopReason === 'end_turn') {
      yield { type: 'done' };
      return;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let approvalPending = false;

    for (const toolUse of toolUseBlocks) {
      const tool = toolMap.get(toolUse.name);
      if (!tool) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Error: Unknown tool "${toolUse.name}"`,
          is_error: true,
        });
        continue;
      }

      const input = toolUse.input as Record<string, unknown>;

      yield { type: 'tool_call', toolName: toolUse.name, toolInput: input };

      // Policy check: evaluate context-aware rules before tier check
      const namespace = (input.namespace ?? input.ns) as string | undefined;
      const policyDecision = evaluatePolicy({
        toolName: toolUse.name,
        toolTier: tool.tier,
        toolInput: input,
        namespace,
        isBusinessHours: isBusinessHours(),
      });

      if (policyDecision === 'deny') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Policy denied: "${toolUse.name}" is not allowed in namespace "${namespace}". The operator namespace is protected from modifications.`,
          is_error: true,
        });
        continue;
      }

      // Tier 3 or policy-escalated: require approval
      const needsApproval = tool.tier === 3 || policyDecision === 'require_approval';
      if (needsApproval) {
        const reason = policyDecision === 'require_approval' && tool.tier < 3
          ? ' (escalated by policy)'
          : '';
        const description = `${toolUse.name}${reason}: ${JSON.stringify(input).slice(0, 200)}`;

        yield {
          type: 'approval_required',
          toolName: toolUse.name,
          description,
          toolInput: input,
        };

        // Synthetic-approval branch: when SYNTH_APPROVER_URL is set
        // (scenario runs), resolve the approval synchronously via
        // the synthetic approver instead of ending the loop. Keeps
        // Emily moving, and the audit trail matches the Slack
        // approver's shape so downstream analysis is commensurable.
        if (isSyntheticApprovalEnabled()) {
          const decision = await requestSyntheticApproval({
            tool: toolUse.name,
            toolInput: input,
          });
          if (decision.kind === 'approved') {
            try {
              const result = await tool.execute(input);
              yield { type: 'tool_result', toolName: toolUse.name, result };
              await logToolExecution({
                userId: decision.approverId,
                toolName: toolUse.name,
                toolInput: input,
                toolTier: tool.tier,
                result,
              });
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify({
                  status: 'approved',
                  approved_by: decision.approverId,
                  decision_delay_ms: decision.delayMs,
                  result: typeof result === 'string' ? result : result,
                }, null, 2),
              });
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: `Error: ${errorMsg}`,
                is_error: true,
              });
            }
            continue; // next tool in this round
          }
          if (decision.kind === 'denied') {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify({
                status: 'denied',
                denied_by: decision.approverId,
                reason: decision.reason,
                note: 'Your tier-3 action was denied by the approver. Try a different approach (tier-1/2 tools) or note the gap in your postmortem. Do NOT retry the same action.',
              }, null, 2),
              is_error: true,
            });
            continue; // next tool in this round — do NOT set approvalPending
          }
          // timeout → fall through to async/Slack path below
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({
            status: 'awaiting_approval',
            message: `This action requires user approval. The user has been prompted to approve or deny: "${description}". Wait for their response.`,
          }),
        });

        approvalPending = true;
        continue;
      }

      // Tier 1 & 2: execute immediately. Tier-2 mutating tools
      // (reversibility ≤ 0.3) go through the speculative-exec
      // wrapper when SPECULATIVE_EXEC=enabled so a regression in
      // the target deployment's readiness auto-reverts within the
      // configured window. Passes through to the plain execute
      // path when disabled or non-qualifying.
      try {
        const specResult = tool.tier === 2
          ? await executeTierTwoWithSpecExec(tool, input)
          : { result: await tool.execute(input) };

        let result = specResult.result;

        // Feed Emily the mechanical revert reason (if any) so she
        // can address it on the next cycle via postmortem /
        // retrieval. The controller has already reverted by the
        // time this block runs.
        if (specResult.revertedMechanicalReason) {
          result = {
            auto_reverted: true,
            mechanical_reason: specResult.revertedMechanicalReason,
            note: 'Your action triggered a regression on the target deployment\'s readiness and was auto-reverted by the speculative-execution controller. Diagnose the semantic cause; do not simply retry the same action.',
          };
        } else if (specResult.pausedForApproval) {
          result = {
            paused_for_approval: true,
            reason: specResult.pausedForApproval,
            note: 'Two consecutive auto-reverts on this target. Further mutations on it are blocked until you present your analysis of why previous attempts failed and a human reviews.',
          };
        }

        yield { type: 'tool_result', toolName: toolUse.name, result };

        // Audit log for Tier 2+ operations
        if (tool.tier >= 2) {
          await logToolExecution({
            userId: request.userId,
            toolName: toolUse.name,
            toolInput: input,
            toolTier: tool.tier,
            result,
          });
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        yield { type: 'tool_result', toolName: toolUse.name, result: { error: errorMsg } };

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Error: ${errorMsg}`,
          is_error: true,
        });
      }
    }

    if (approvalPending) {
      messages.push({ role: 'assistant', content: finalMessage.content });
      messages.push({ role: 'user', content: toolResults });

      const followUp = client.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages,
        tools: anthropicTools,
      });

      for await (const event of followUp) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'token', content: event.delta.text };
        }
      }

      yield { type: 'done' };
      return;
    }

    messages.push({ role: 'assistant', content: finalMessage.content });
    messages.push({ role: 'user', content: toolResults });
  }

  yield { type: 'error', content: `Agent reached maximum tool rounds (${MAX_TOOL_ROUNDS})` };
  yield { type: 'done' };
}
