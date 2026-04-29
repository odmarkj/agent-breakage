import Anthropic from '@anthropic-ai/sdk';
import { listGoals, transitionGoal, addToolToGoal } from './store.js';
import { getToolsForRole } from '../tools/index.js';
import { logToolExecution } from '../audit.js';
import { evaluatePolicy, isBusinessHours } from '../policies/rules.js';
import { sendSlackMessage, splitIntoSectionBlocks } from '../watchers/slack.js';
import { getStableContext } from '../memory/stable.js';
import { getEntityFacts } from '../memory/entity.js';
import { searchEpisodes } from '../memory/episodic.js';
import { getLearningsForPrompt, extractAndStoreLearnings } from '../memory/learnings.js';
import {
  getOrCreateSessionId,
  appendConversationMessage,
  formatSessionHistoryForPrompt,
} from '../memory/session.js';
import type { Goal } from '../types.js';
import { emit } from '../lib/events.js';
import { buildBreakageSections } from '../breakage/prompt-sections.js';

const client = new Anthropic();
const MODEL = process.env.OPERATOR_MODEL ?? 'claude-sonnet-4-20250514';
const MAX_TOKENS = 8192;
const MAX_TOOL_ROUNDS = 35;
const POLL_INTERVAL = 30_000; // 30 seconds
const SLACK_CHANNEL_ALERTS = process.env.SLACK_CHANNEL_ALERTS ?? '#k3s';

/** Truncate text at a sentence boundary, falling back to word boundary. */
function truncateAtBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  // Try to break at the last sentence-ending punctuation
  const sentenceEnd = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('.\n'),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('?\n'),
  );
  if (sentenceEnd > maxLen * 0.5) return truncated.slice(0, sentenceEnd + 1);
  // Fall back to last word boundary
  const wordEnd = truncated.lastIndexOf(' ');
  if (wordEnd > maxLen * 0.5) return truncated.slice(0, wordEnd) + '…';
  return truncated + '…';
}

let _interval: ReturnType<typeof setInterval> | null = null;
let _running = false;

async function buildGoalSystemPrompt(goal: Goal, sessionId: string): Promise<string> {
  const parts: string[] = [];

  // ── Stable context (human-managed cluster knowledge) ─────────────
  const stableContext = getStableContext();
  if (stableContext) {
    parts.push(`## Cluster Context\n${stableContext}\n`);
  }

  // ── Entity memory (per-service facts) ────────────────────────────
  if (goal.context) {
    try {
      const details = JSON.parse(goal.context);
      const ns = details.namespace as string | undefined;
      const pod = details.pod as string | undefined;
      if (ns && pod) {
        const deployment = pod.replace(/-[a-z0-9]+-[a-z0-9]+$/, '');
        const facts = await getEntityFacts('service', deployment);
        if (facts.length > 0) {
          parts.push(`## Known Facts About ${deployment}\n${facts.map((f) => `- ${f.fact} (${f.source})`).join('\n')}\n`);
        }
      }
    } catch { /* context not JSON */ }
  }

  // ── Session history (what Emily already investigated today) ──────
  const sessionHistory = await formatSessionHistoryForPrompt(sessionId, goal.id);
  if (sessionHistory) {
    parts.push(sessionHistory);
  }

  // ── Operator learnings (Emily's evolved knowledge) ───────────────
  const learnings = getLearningsForPrompt(goal.title, 2000);
  if (learnings) {
    parts.push(learnings);
  }

  // ── Past incidents (episodic memory) ─────────────────────────────
  const episodes = await searchEpisodes(goal.title, 3);
  if (episodes.length > 0) {
    const epLines = episodes.map((e) => `- **${e.title}**: ${e.summary}`);
    parts.push(`## Past Incidents\n${epLines.join('\n')}\n`);
  }

  // ── Shared breakage-framework sections (retrieval + playbook +
  //    vocab + synthetic-approval note). Query string combines the
  //    goal's title + context so retrieval can match on symptom +
  //    affected resource.
  const breakageQuery = [goal.title, goal.context ?? ''].filter(Boolean).join(' — ');
  const breakage = await buildBreakageSections({ query: breakageQuery });
  if (breakage.text) parts.push(breakage.text);

  // ── Goal details and guidelines ──────────────────────────────────
  parts.push(`## Your Role
You are Emily, the K3S cluster operator. You execute autonomous goals to investigate and resolve cluster issues.

## Goal
- **Title:** ${goal.title}
- **Objective:** ${goal.objective}
- **Risk Class:** ${goal.riskClass}
- **Context:** ${goal.context || 'none'}

## Guidelines
- Check the "Recent Investigation History" section above — do NOT repeat work you already did.
- Investigate the issue using read-only tools first (kubectl_get, kubectl_describe, kubectl_logs).
- Determine the root cause before taking action.
- For low/medium risk: fix the issue using available tools.
- For high risk: investigate and report findings, but do not take destructive action without approval.
- Be concise. Report what you found and what you did.
- If the issue has already resolved itself, report that clearly and move on.
- If a tool is blocked for approval, do NOT retry it. Summarize what you found so far.

## Code-Level Bug Fix
If your investigation reveals an application-level bug that cannot be fixed by restarting, scaling, or reconfiguring:
1. Gather error logs, stack traces, and your root-cause diagnosis.
2. Look up the service in the "Service → Repository Mapping" section of Cluster Context.
3. Use spawn_code_fix with your diagnosis, log snippets, and the GitHub repo from the mapping. The repo will be cloned automatically in your workspace.
4. Poll with check_code_fix a few times, waiting between calls. Do not poll excessively — 3-4 checks is enough.
5. Monitor the CI build with check_ci_status using the GitHub repo name.
6. When CI passes, use kubectl_rollout_restart to deploy the fix.
7. Verify the service recovers by checking pod status and logs.

Signs that a code fix is needed (vs an ops fix):
- Application exception in logs (not OOM, not network timeout)
- Bug persists across pod restarts
- Error traces to application source code (stack trace with file names)
- Health check fails due to application errors, not infrastructure
`);

  return parts.join('\n');
}

/**
 * Execute a single goal autonomously using the agent loop.
 * Tier 1 & 2 tools execute immediately. Tier 3 tools are skipped
 * (the goal is marked as needing escalation via Slack).
 */
async function executeGoal(goal: Goal): Promise<void> {
  // Transition: proposed → approved → active → in_progress
  await transitionGoal(goal.id, 'approved');
  await transitionGoal(goal.id, 'active');
  await transitionGoal(goal.id, 'in_progress');

  const sessionId = getOrCreateSessionId();

  const tools = getToolsForRole('admin');
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  const systemPrompt = await buildGoalSystemPrompt(goal, sessionId);
  const userMessage = `Execute this goal: ${goal.objective}\n\nContext: ${goal.context || 'none'}`;
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userMessage },
  ];

  // Log the initial user message to session
  await appendConversationMessage(sessionId, goal.id, 'user', userMessage);

  let rounds = 0;
  const actions: string[] = [];
  let needsEscalation = false;
  const blockedTools = new Set<string>();

  try {
    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;

      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages,
        tools: anthropicTools,
      });

      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === 'text',
      );

      // Collect text output
      for (const block of textBlocks) {
        if (block.text.trim()) actions.push(block.text.trim());
      }

      if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

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
        const namespace = (input.namespace ?? input.ns) as string | undefined;
        const policyDecision = evaluatePolicy({
          toolName: toolUse.name,
          toolTier: tool.tier,
          toolInput: input,
          namespace,
          isBusinessHours: isBusinessHours(),
        });

        emit(goal.id, 'TOOL_POLICY_EVALUATED', {
          toolName: toolUse.name,
          toolTier: tool.tier,
          namespace,
          decision: policyDecision,
          isBusinessHours: isBusinessHours(),
        });

        if (policyDecision === 'deny') {
          emit(goal.id, 'TOOL_DENIED', {
            toolName: toolUse.name,
            reason: 'policy_deny',
            namespace,
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Policy denied: "${toolUse.name}" blocked by policy.`,
            is_error: true,
          });
          continue;
        }

        // Tier 3 (unless policy overrode to audit/allow) or policy-escalated: skip and flag for human review
        if ((tool.tier === 3 && policyDecision !== 'audit' && policyDecision !== 'allow') || policyDecision === 'require_approval') {
          needsEscalation = true;
          blockedTools.add(toolUse.name);
          const description = `${toolUse.name}: ${truncateAtBoundary(JSON.stringify(input), 200)}`;
          actions.push(`⏸️ Needs approval: ${description}`);

          emit(goal.id, 'TOOL_APPROVAL_REQUESTED', {
            toolName: toolUse.name,
            toolTier: tool.tier,
            reason: tool.tier === 3 ? 'tier3' : 'policy_escalation',
            inputSummary: JSON.stringify(input).slice(0, 500),
          });

          // Notify via Slack
          try {
            await sendSlackMessage({
              channel: SLACK_CHANNEL_ALERTS,
              text: `🔐 *Approval needed* for goal \`${goal.id}\`:\n\`${description}\``,
              blocks: [
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: `🔐 *Approval needed* for goal \`${goal.id}\`\n*Action:* \`${toolUse.name}\`\n*Input:* \`\`\`${truncateAtBoundary(JSON.stringify(input, null, 2), 500)}\`\`\``,
                  },
                },
                {
                  type: 'actions',
                  elements: [
                    { type: 'button', text: { type: 'plain_text', text: '✅ Approve' }, action_id: 'approve_tool', value: JSON.stringify({ goalId: goal.id, tool: toolUse.name, input }) },
                    { type: 'button', text: { type: 'plain_text', text: '❌ Deny' }, action_id: 'deny_tool', value: JSON.stringify({ goalId: goal.id, tool: toolUse.name }), style: 'danger' },
                  ],
                },
              ],
            });
          } catch (err) {
            // Slack send failure shouldn't block goal execution
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `BLOCKED: "${toolUse.name}" requires human approval and has been sent to Slack. Do NOT retry this tool or any other blocked tool (${[...blockedTools].join(', ')}). Conclude your investigation with the read-only information you already have, and summarize your findings.`,
            is_error: true,
          });
          continue;
        }

        // Tier 1 & 2: execute
        try {
          const result = await tool.execute(input);
          await addToolToGoal(goal.id, toolUse.name);

          if (tool.tier >= 2) {
            await logToolExecution({
              userId: 'operator-auto',
              toolName: toolUse.name,
              toolInput: input,
              toolTier: tool.tier,
              result,
              goalId: goal.id,
            });
          }

          emit(goal.id, 'TOOL_EXECUTED', {
            toolName: toolUse.name,
            toolTier: tool.tier,
            inputSummary: JSON.stringify(input).slice(0, 500),
            resultSummary: (typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 500),
          });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);

          emit(goal.id, 'TOOL_FAILED', {
            toolName: toolUse.name,
            toolTier: tool.tier,
            error: errorMsg,
          });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error: ${errorMsg}`,
            is_error: true,
          });
        }
      }

      emit(goal.id, 'GOAL_ROUND_COMPLETED', {
        round: rounds,
        toolsCalled: toolUseBlocks.map((t) => t.name),
        hasMoreWork: true,
      });

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      // Save assistant text to session log for cross-goal continuity
      const assistantText = textBlocks.map((b) => b.text).join('\n').trim();
      if (assistantText) {
        await appendConversationMessage(sessionId, goal.id, 'assistant', assistantText);
      }
    }

    const outcome = actions.join('\n\n');
    const finalStatus = needsEscalation ? 'failed' : 'completed';
    const statusLabel = needsEscalation ? 'blocked (needs approval)' : 'completed';

    if (needsEscalation) {
      emit(goal.id, 'GOAL_ESCALATED', {
        blockedTools: [...blockedTools],
        rounds,
      });
    }

    await transitionGoal(goal.id, finalStatus, outcome || 'Goal executed, no notable findings.');

    // Save final outcome to session log
    await appendConversationMessage(sessionId, goal.id, 'assistant', `[OUTCOME: ${statusLabel}] ${outcome || 'No notable findings.'}`);

    // Extract learnings from successful completions
    if (finalStatus === 'completed' && outcome) {
      extractAndStoreLearnings(goal.id, goal.title, outcome).catch(() => {});
    }

    // Report completion to Slack — keep it concise, especially for blocked goals
    const emoji = needsEscalation ? '🔐' : '✅';
    const header = `${emoji} *Goal ${statusLabel}:* ${goal.title}`;
    // For blocked goals, only show the blocked tools (the investigation narrative is noise).
    // For completed goals, send full outcome split across multiple section blocks.
    const slackOutcome = needsEscalation
      ? `Blocked tools: ${[...blockedTools].join(', ')}`
      : (outcome || 'No notable findings.');
    const outcomeBlocks = splitIntoSectionBlocks(`${header}\n*Outcome:*\n${slackOutcome}`);
    try {
      await sendSlackMessage({
        channel: SLACK_CHANNEL_ALERTS,
        text: `${emoji} Goal ${statusLabel}: ${goal.title}`,
        blocks: outcomeBlocks,
      });
    } catch { /* Slack failure non-fatal */ }

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    try {
      await transitionGoal(goal.id, 'failed', `Execution error: ${errorMsg}`);
    } catch { /* transition may fail if already terminal */ }

    try {
      await sendSlackMessage({
        channel: SLACK_CHANNEL_ALERTS,
        text: `❌ Goal \`${goal.id}\` failed: ${errorMsg}`,
      });
    } catch { /* Slack failure non-fatal */ }
  }
}

/**
 * Poll for proposed goals and execute them.
 * Escalation goals (high risk, approval required) get Slack approval requests.
 * Routine/urgent goals are auto-approved and executed.
 */
async function pollAndExecuteGoals(): Promise<void> {
  if (_running) return; // prevent overlapping runs
  _running = true;

  try {
    const proposed = await listGoals({ status: 'proposed' });
    if (proposed.length === 0) return;

    for (const goal of proposed) {
      // High risk goals that require approval: send to Slack and skip
      if (goal.approvalRequired) {
        await transitionGoal(goal.id, 'approved'); // mark as awaiting action
        try {
          await sendSlackMessage({
            channel: SLACK_CHANNEL_ALERTS,
            text: `🚨 *Escalation:* ${goal.title}\nGoal \`${goal.id}\` requires human approval before the operator can act.`,
          });
        } catch { /* non-fatal */ }
        continue;
      }

      // Routine/urgent: auto-execute
      await executeGoal(goal);
    }
  } finally {
    _running = false;
  }
}

export function startGoalExecutor(): void {
  // Run once immediately, then on interval
  pollAndExecuteGoals().catch(() => {});
  _interval = setInterval(() => {
    pollAndExecuteGoals().catch(() => {});
  }, POLL_INTERVAL);
}

export function stopGoalExecutor(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}
