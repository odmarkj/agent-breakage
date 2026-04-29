import type { ClusterEvent } from '../types.js';
import { ingestEvent, newEventId } from './index.js';

/**
 * GitHub webhook event parser.
 * Called from server.ts POST /webhook/github endpoint.
 */

export async function handleGitHubWebhook(
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  switch (eventType) {
    case 'push':
      await handlePush(payload);
      break;
    case 'workflow_run':
      await handleWorkflowRun(payload);
      break;
    case 'pull_request':
      await handlePullRequest(payload);
      break;
    default:
      // Ignore other event types
      break;
  }
}

async function handlePush(payload: Record<string, unknown>): Promise<void> {
  const ref = payload.ref as string;
  const branch = ref?.replace('refs/heads/', '');
  const repo = (payload.repository as Record<string, unknown>)?.full_name as string;
  const commits = payload.commits as Array<Record<string, unknown>> ?? [];
  const headCommit = payload.head_commit as Record<string, unknown>;

  await ingestEvent({
    id: newEventId(),
    source: 'github',
    kind: 'push',
    summary: `Push to ${repo}/${branch}: ${headCommit?.message ?? `${commits.length} commits`}`,
    details: {
      repo,
      branch,
      commitCount: commits.length,
      headSha: (headCommit?.id as string)?.slice(0, 8),
      message: headCommit?.message,
      pusher: (payload.pusher as Record<string, unknown>)?.name,
    },
    timestamp: new Date(),
  });
}

async function handleWorkflowRun(payload: Record<string, unknown>): Promise<void> {
  const action = payload.action as string;
  if (action !== 'completed') return; // only care about completed runs

  const workflowRun = payload.workflow_run as Record<string, unknown>;
  const conclusion = workflowRun?.conclusion as string;
  const name = workflowRun?.name as string;
  const repo = (payload.repository as Record<string, unknown>)?.full_name as string;
  const branch = workflowRun?.head_branch as string;

  await ingestEvent({
    id: newEventId(),
    source: 'github',
    kind: `workflow_${conclusion}`,
    summary: `Workflow "${name}" ${conclusion} on ${repo}/${branch}`,
    details: {
      repo,
      branch,
      workflow: name,
      conclusion,
      runId: workflowRun?.id,
      url: workflowRun?.html_url,
    },
    timestamp: new Date(),
  });
}

async function handlePullRequest(payload: Record<string, unknown>): Promise<void> {
  const action = payload.action as string;
  if (!['opened', 'closed', 'merged'].includes(action)) return;

  const pr = payload.pull_request as Record<string, unknown>;
  const repo = (payload.repository as Record<string, unknown>)?.full_name as string;
  const merged = pr?.merged as boolean;
  const effectiveAction = merged ? 'merged' : action;

  await ingestEvent({
    id: newEventId(),
    source: 'github',
    kind: `pr_${effectiveAction}`,
    summary: `PR #${pr?.number} ${effectiveAction} on ${repo}: ${pr?.title}`,
    details: {
      repo,
      prNumber: pr?.number,
      title: pr?.title,
      action: effectiveAction,
      author: (pr?.user as Record<string, unknown>)?.login,
      url: pr?.html_url,
    },
    timestamp: new Date(),
  });
}
