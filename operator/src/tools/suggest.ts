import type { ToolDefinition } from '../types.js';

/**
 * Tool that lets the operator suggest CLI commands for the user to run.
 * Used for interactive operations that can't be executed server-side
 * (port-forward, SSH, exec into pods, etc.)
 */

export const suggestCommand: ToolDefinition = {
  name: 'suggest_command',
  description:
    `Suggest a k3s-cli command for the user to run on their machine. Use this for interactive operations that require a local terminal: port-forwarding, SSH, exec into pods, database connections, etc. The command will be displayed prominently to the user.

Available k3s-cli shortcuts:
- k3s-cli db                         Port-forward to postgres (localhost:5432)
- k3s-cli logs <service> [-f]        Tail logs (services: bsa, asyncro, ml-scoring, libpostal, name-matching, pg)
- k3s-cli exec <service> [cmd]       Shell into a pod
- k3s-cli forward <svc> <local>:<remote>   Port-forward any service
- k3s-cli top [service]              CPU/memory usage
- k3s-cli restart <service>          Rolling restart
- k3s-cli ssh <node>                 SSH into a server node
- k3s-cli kubectl <args>             Direct kubectl
- k3s-cli keys list                  List SSH keys on nodes`,
  tier: 1,
  reversibility: 0.0,
  adminOnly: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      command: {
        type: 'string',
        description: 'The k3s-cli command to suggest (e.g., "k3s-cli db", "k3s-cli exec bsa")',
      },
      explanation: {
        type: 'string',
        description: 'Brief explanation of what the command does',
      },
    },
    required: ['command', 'explanation'],
  },
  async execute(input) {
    const command = input.command as string;
    const explanation = input.explanation as string;

    return {
      suggested_command: command,
      explanation,
      note: 'Run this command in your terminal.',
    };
  },
};
