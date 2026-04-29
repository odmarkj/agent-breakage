import type { ToolDefinition } from '../types.js';
import {
  kubectlGet,
  kubectlDescribe,
  kubectlLogs,
  kubectlTop,
  kubectlScale,
  kubectlExec,
  kubectlApply,
  kubectlDelete,
  kubectlRolloutRestart,
  kubectlRolloutUndo,
  postgresQuery,
} from './kubectl.js';
import {
  helmList,
  helmStatus,
  helmHistory,
  helmUpgrade,
  helmRollback,
} from './helm.js';
import { shellExec } from './shell.js';
import { readFileTool, listFilesTool } from './filesystem.js';
import { suggestCommand } from './suggest.js';
import { spawnCodeFix, checkCodeFix, checkCIStatus } from './codefix.js';
import { writePostmortem } from './postmortem.js';
import { emitHypothesis } from './hypothesis.js';

/** All registered tools, ordered by tier */
const ALL_TOOLS: ToolDefinition[] = [
  // ── Tier 1: Read-only, auto-execute ──────────────────────────────
  kubectlGet,
  kubectlDescribe,
  kubectlLogs,
  kubectlTop,
  helmList,
  helmStatus,
  helmHistory,
  readFileTool,
  listFilesTool,
  suggestCommand,

  checkCodeFix,
  checkCIStatus,
  emitHypothesis,
  writePostmortem,

  // ── Tier 2: Autonomous ops, audit logged ─────────────────────────
  kubectlScale,
  kubectlExec,
  kubectlRolloutRestart,
  kubectlRolloutUndo,
  shellExec,
  spawnCodeFix,

  // ── Tier 3: Destructive or data-modifying, requires approval ─────
  kubectlApply,
  kubectlDelete,
  postgresQuery,
  helmUpgrade,
  helmRollback,
];

/**
 * Return tools available to a given user role.
 * Non-admin users only get non-adminOnly tools.
 */
export function getToolsForRole(role: 'admin' | 'user'): ToolDefinition[] {
  if (role === 'admin') return ALL_TOOLS;
  return ALL_TOOLS.filter((t) => !t.adminOnly);
}

/** Look up a tool by name (used by the Slack approval handler to run a
 *  specifically-approved tool call after a human clicked Approve). */
export function findToolByName(name: string): ToolDefinition | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}
