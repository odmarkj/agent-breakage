import { execSync } from 'node:child_process';
import type { ToolDefinition } from '../types.js';
import { assertCommandAllowed } from './blocked-commands.js';

export const shellExec: ToolDefinition = {
  name: 'shell_exec',
  description:
    'Execute a shell command on the operator host. Use for diagnostics, file inspection, or system checks. Audit logged. Blocks dangerous patterns.',
  tier: 2,
  reversibility: 0.7,
  adminOnly: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (default: /workspaces/k3s)',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 10000, max: 60000)',
      },
    },
    required: ['command'],
  },
  async execute(input) {
    const command = input.command as string;
    const cwd = (input.cwd as string) ?? '/workspaces/k3s';
    const timeout = Math.min((input.timeout as number) ?? 10_000, 60_000);

    assertCommandAllowed(command);

    const output = execSync(command, {
      encoding: 'utf-8',
      timeout,
      maxBuffer: 1024 * 1024,
      cwd,
    }).trim();

    return { command, output };
  },
};
