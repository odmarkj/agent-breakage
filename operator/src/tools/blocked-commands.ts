// Shared command-pattern blocklist used by tools that accept arbitrary
// command strings (shell_exec, kubectl_exec). Substring matching; trailing
// space on CLI names keeps us from accidentally blocking files/paths that
// just happen to share the name.
//
// Two categories:
//   1. Destructive / OS-level actions that have no safe autonomous use.
//   2. CLIs that have dedicated Tier-1/2/3 tool wrappers. Routing them
//      through a Tier-2 auto-execute tool (shell_exec, kubectl_exec)
//      bypasses Tier-3 approval entirely, so we refuse them here.
//
// If you need to add a CLI to the Tier-3 gate, add it here AND wire up a
// dedicated tool under this directory with the correct tier classification.

export const BLOCKED_COMMAND_PATTERNS: readonly string[] = [
  // Destructive / OS-level
  'rm -rf /',
  'mkfs',
  'dd if=',
  'shutdown',
  'reboot',
  '> /dev/',
  'chmod 777',
  'curl | bash',
  'wget | bash',
  'curl | sh',
  'wget | sh',
  // Cluster / DB / cloud CLIs — use dedicated tools instead
  'kubectl ',
  'kubeadm',
  'psql',
  'pg_dump',
  'pg_restore',
  'helm ',
  'hcloud ',
  'doctl ',
  'vultr-cli',
  // Defense in depth: never authenticate as the Postgres superuser, no
  // matter which binary is used or which pod it runs inside.
  '-U postgres',
];

/**
 * Throws if `command` matches any blocked pattern. Call this from every
 * tool that executes a user-supplied command string.
 */
export function assertCommandAllowed(command: string): void {
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (command.includes(pattern)) {
      throw new Error(`Blocked command pattern: "${pattern}"`);
    }
  }
}
