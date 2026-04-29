import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolDefinition } from '../types.js';
import { assertCommandAllowed } from './blocked-commands.js';

function getKubeconfig(): string | undefined {
  const candidates = [
    process.env.K3S_KUBECONFIG,
    resolve(process.cwd(), '..', 'infra', 'kubeconfig'),
    resolve(process.env.HOME ?? '', '.k3s', 'kubeconfig'),
    process.env.KUBECONFIG,
    resolve(process.env.HOME ?? '', '.kube', 'config'),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return undefined;
}

function kubectlEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  const kc = getKubeconfig();
  if (kc) env.KUBECONFIG = kc;
  return env;
}

function runKubectl(args: string, timeout = 10_000): string {
  return execSync(`kubectl ${args}`, {
    encoding: 'utf-8',
    timeout,
    maxBuffer: 1024 * 1024,
    env: kubectlEnv(),
  }).trim();
}

/** Sanitize resource names to prevent command injection */
function sanitizeName(name: string): string {
  if (!/^[a-zA-Z0-9._/-]+$/.test(name)) {
    throw new Error(`Invalid resource name: "${name}"`);
  }
  return name;
}

function sanitizeNamespace(ns: string): string {
  if (!/^[a-z0-9-]+$/.test(ns)) {
    throw new Error(`Invalid namespace: "${ns}"`);
  }
  return ns;
}

// ── Tier 1: Read-only ───────────────────────────────────────────────

export const kubectlGet: ToolDefinition = {
  name: 'kubectl_get',
  description:
    'Get Kubernetes resources. Returns a table of matching resources. Use this to discover pods, deployments, services, nodes, events, namespaces, etc.',
  tier: 1,
  reversibility: 0.0,
  adminOnly: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      resource: {
        type: 'string',
        description: 'Resource type (e.g., pods, deployments, services, nodes, events, namespaces, pvc, ingress, certificates, certificaterequests, orders, challenges)',
      },
      namespace: {
        type: 'string',
        description: 'Namespace to query. Omit or use "--all-namespaces" for all.',
      },
      name: {
        type: 'string',
        description: 'Optional specific resource name',
      },
      output: {
        type: 'string',
        description: 'Output format: wide, yaml, json. Default: wide',
      },
    },
    required: ['resource'],
  },
  async execute(input) {
    const resource = sanitizeName(input.resource as string);
    const ns = input.namespace as string | undefined;
    const name = input.name ? sanitizeName(input.name as string) : '';
    const output = (input.output as string) ?? 'wide';

    let cmd = `get ${resource}`;
    if (name) cmd += ` ${name}`;
    if (ns === '--all-namespaces' || ns === '-A') {
      cmd += ' --all-namespaces';
    } else if (ns) {
      cmd += ` -n ${sanitizeNamespace(ns)}`;
    }
    cmd += ` -o ${output}`;

    return { output: runKubectl(cmd) };
  },
};

export const kubectlDescribe: ToolDefinition = {
  name: 'kubectl_describe',
  description:
    'Describe a specific Kubernetes resource in detail. Shows events, conditions, and configuration.',
  tier: 1,
  reversibility: 0.0,
  adminOnly: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      resource: {
        type: 'string',
        description: 'Resource type (e.g., pod, deployment, node, service)',
      },
      name: {
        type: 'string',
        description: 'Resource name',
      },
      namespace: {
        type: 'string',
        description: 'Namespace (omit for cluster-scoped resources)',
      },
    },
    required: ['resource', 'name'],
  },
  async execute(input) {
    const resource = sanitizeName(input.resource as string);
    const name = sanitizeName(input.name as string);
    const ns = input.namespace as string | undefined;

    let cmd = `describe ${resource} ${name}`;
    if (ns) cmd += ` -n ${sanitizeNamespace(ns)}`;

    return { output: runKubectl(cmd, 15_000) };
  },
};

export const kubectlLogs: ToolDefinition = {
  name: 'kubectl_logs',
  description:
    'Get logs from a pod. Returns the last N lines (default 100). Can filter by container.',
  tier: 1,
  reversibility: 0.0,
  adminOnly: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      pod: {
        type: 'string',
        description: 'Pod name',
      },
      namespace: {
        type: 'string',
        description: 'Namespace',
      },
      container: {
        type: 'string',
        description: 'Container name (for multi-container pods)',
      },
      lines: {
        type: 'number',
        description: 'Number of lines to return (default: 100)',
      },
      since: {
        type: 'string',
        description: 'Only return logs since this duration (e.g., "1h", "30m", "5s")',
      },
    },
    required: ['pod', 'namespace'],
  },
  async execute(input) {
    const pod = sanitizeName(input.pod as string);
    const ns = sanitizeNamespace(input.namespace as string);
    const container = input.container ? sanitizeName(input.container as string) : '';
    const lines = (input.lines as number) ?? 100;
    const since = input.since as string | undefined;

    let cmd = `logs ${pod} -n ${ns} --tail=${lines}`;
    if (container) cmd += ` -c ${container}`;
    if (since) {
      if (!/^\d+[smhd]$/.test(since)) throw new Error(`Invalid duration: "${since}"`);
      cmd += ` --since=${since}`;
    }

    return { pod, namespace: ns, output: runKubectl(cmd, 15_000) };
  },
};

export const kubectlTop: ToolDefinition = {
  name: 'kubectl_top',
  description:
    'Show resource usage (CPU/memory) for nodes or pods. Requires metrics-server.',
  tier: 1,
  reversibility: 0.0,
  adminOnly: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      resource: {
        type: 'string',
        description: '"nodes" or "pods"',
        enum: ['nodes', 'pods'],
      },
      namespace: {
        type: 'string',
        description: 'Namespace for pods (omit for all namespaces)',
      },
    },
    required: ['resource'],
  },
  async execute(input) {
    const resource = input.resource as string;
    const ns = input.namespace as string | undefined;

    let cmd = `top ${resource}`;
    if (resource === 'pods') {
      if (ns) {
        cmd += ` -n ${sanitizeNamespace(ns)}`;
      } else {
        cmd += ' --all-namespaces';
      }
    }

    return { output: runKubectl(cmd) };
  },
};

// ── Tier 2: Write with audit ────────────────────────────────────────

export const kubectlScale: ToolDefinition = {
  name: 'kubectl_scale',
  description:
    'Scale a deployment, statefulset, or replicaset. Changes the number of replicas. Audit logged.',
  tier: 2,
  reversibility: 0.3,
  adminOnly: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      resource: {
        type: 'string',
        description: 'Resource type (deployment, statefulset, replicaset)',
      },
      name: {
        type: 'string',
        description: 'Resource name',
      },
      namespace: {
        type: 'string',
        description: 'Namespace',
      },
      replicas: {
        type: 'number',
        description: 'Desired number of replicas',
      },
    },
    required: ['resource', 'name', 'namespace', 'replicas'],
  },
  async execute(input) {
    const resource = sanitizeName(input.resource as string);
    const name = sanitizeName(input.name as string);
    const ns = sanitizeNamespace(input.namespace as string);
    const replicas = input.replicas as number;

    if (replicas < 0 || replicas > 50) {
      throw new Error(`Replicas must be between 0 and 50, got ${replicas}`);
    }

    const output = runKubectl(`scale ${resource}/${name} -n ${ns} --replicas=${replicas}`);
    return { resource, name, namespace: ns, replicas, output };
  },
};

export const kubectlExec: ToolDefinition = {
  name: 'kubectl_exec',
  description:
    'Execute a command inside a running pod. Audit logged. Use for diagnostics only.',
  tier: 2,
  reversibility: 0.7,
  adminOnly: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      pod: {
        type: 'string',
        description: 'Pod name',
      },
      namespace: {
        type: 'string',
        description: 'Namespace',
      },
      container: {
        type: 'string',
        description: 'Container name (for multi-container pods)',
      },
      command: {
        type: 'string',
        description: 'Command to execute (e.g., "ls /app", "cat /etc/config")',
      },
    },
    required: ['pod', 'namespace', 'command'],
  },
  async execute(input) {
    const pod = sanitizeName(input.pod as string);
    const ns = sanitizeNamespace(input.namespace as string);
    const container = input.container ? sanitizeName(input.container as string) : '';
    const command = input.command as string;

    // Same shared blocklist shell_exec uses — kubectl_exec is otherwise a
    // trivial back door to run psql / -U postgres / other CLIs inside the
    // target pod and bypass Tier-3 approval.
    assertCommandAllowed(command);

    let cmd = `exec ${pod} -n ${ns}`;
    if (container) cmd += ` -c ${container}`;
    cmd += ` -- ${command}`;

    return { pod, namespace: ns, output: runKubectl(cmd, 30_000) };
  },
};

// ── Tier 3: Destructive, requires approval ──────────────────────────

export const kubectlApply: ToolDefinition = {
  name: 'kubectl_apply',
  description:
    'Apply a Kubernetes manifest. REQUIRES APPROVAL. Provide the manifest as YAML content.',
  tier: 3,
  reversibility: 1.0,
  adminOnly: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      manifest: {
        type: 'string',
        description: 'YAML manifest content to apply',
      },
      namespace: {
        type: 'string',
        description: 'Namespace (can also be specified in the manifest)',
      },
    },
    required: ['manifest'],
  },
  async execute(input) {
    const manifest = input.manifest as string;
    const ns = input.namespace as string | undefined;

    let cmd = 'apply -f -';
    if (ns) cmd += ` -n ${sanitizeNamespace(ns)}`;

    const output = execSync(`echo '${manifest.replace(/'/g, "'\\''")}' | kubectl ${cmd}`, {
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: kubectlEnv(),
    }).trim();

    return { output };
  },
};

export const kubectlDelete: ToolDefinition = {
  name: 'kubectl_delete',
  description:
    'Delete a Kubernetes resource. REQUIRES APPROVAL. This is destructive and cannot be undone.',
  tier: 3,
  reversibility: 1.0,
  adminOnly: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      resource: {
        type: 'string',
        description: 'Resource type (e.g., pod, deployment, service)',
      },
      name: {
        type: 'string',
        description: 'Resource name',
      },
      namespace: {
        type: 'string',
        description: 'Namespace',
      },
    },
    required: ['resource', 'name', 'namespace'],
  },
  async execute(input) {
    const resource = sanitizeName(input.resource as string);
    const name = sanitizeName(input.name as string);
    const ns = sanitizeNamespace(input.namespace as string);

    const output = runKubectl(`delete ${resource} ${name} -n ${ns}`, 60_000);
    return { resource, name, namespace: ns, output };
  },
};

export const kubectlRolloutRestart: ToolDefinition = {
  name: 'kubectl_rollout_restart',
  description:
    'Restart a deployment via rolling restart. Zero-downtime restart. Audit logged.',
  tier: 2,
  reversibility: 0.3,
  adminOnly: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      resource: {
        type: 'string',
        description: 'Resource type (deployment, statefulset)',
      },
      name: {
        type: 'string',
        description: 'Resource name',
      },
      namespace: {
        type: 'string',
        description: 'Namespace',
      },
    },
    required: ['resource', 'name', 'namespace'],
  },
  async execute(input) {
    const resource = sanitizeName(input.resource as string);
    const name = sanitizeName(input.name as string);
    const ns = sanitizeNamespace(input.namespace as string);

    const output = runKubectl(`rollout restart ${resource}/${name} -n ${ns}`);
    return { resource, name, namespace: ns, output };
  },
};

export const kubectlRolloutUndo: ToolDefinition = {
  name: 'kubectl_rollout_undo',
  description:
    'Rollback a deployment to the previous revision. Audit logged.',
  tier: 2,
  reversibility: 0.3,
  adminOnly: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      resource: {
        type: 'string',
        description: 'Resource type (deployment, statefulset)',
      },
      name: {
        type: 'string',
        description: 'Resource name',
      },
      namespace: {
        type: 'string',
        description: 'Namespace',
      },
    },
    required: ['resource', 'name', 'namespace'],
  },
  async execute(input) {
    const resource = sanitizeName(input.resource as string);
    const name = sanitizeName(input.name as string);
    const ns = sanitizeNamespace(input.namespace as string);

    const output = runKubectl(`rollout undo ${resource}/${name} -n ${ns}`);
    return { resource, name, namespace: ns, output };
  },
};

// ── SQL Tool (via kubectl exec into postgres) ──────────────────────

const POSTGRES_DATABASES = ['postgres', 'bsa', 'lde_engine', 'k3s_operator', 'advocate', 'listing_mgmt_staging', 'publisher_reviews'];
const POSTGRES_PRIMARY_POD = 'postgres-1';

// Always authenticate as operator_user. operator_user has pg_monitor +
// pg_read_all_data (read-only across every DB) plus ownership of the
// k3s_operator DB. Any write outside k3s_operator — `ALTER USER`,
// password rotation, CREATE DATABASE, etc. — fails at the Postgres planner
// with permission denied, regardless of tier-3 policy gates on this tool.
const OPERATOR_PG_USER = 'operator_user';

function operatorPgPassword(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return '';
  try {
    return new URL(url).password;
  } catch {
    return '';
  }
}

export const postgresQuery: ToolDefinition = {
  name: 'postgres_query',
  description:
    'Execute a SQL statement against the cluster PostgreSQL database via kubectl exec. Runs as `operator_user` — read-only across all DBs (pg_read_all_data + pg_monitor), write privileges limited to k3s_operator DB only. Mutations elsewhere (ALTER USER, password rotation, CREATE DATABASE) fail with permission denied at the planner regardless of policy gates. Available databases: postgres, bsa, lde_engine, k3s_operator, advocate, listing_mgmt_staging, publisher_reviews.',
  tier: 3,
  reversibility: 1.0,
  adminOnly: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      sql: {
        type: 'string',
        description: 'SQL statement to execute',
      },
      database: {
        type: 'string',
        description: 'Database name (postgres, bsa, lde_engine, k3s_operator, advocate, listing_mgmt_staging, publisher_reviews)',
      },
    },
    required: ['sql', 'database'],
  },
  async execute(input) {
    const sql = input.sql as string;
    const database = input.database as string;

    if (!POSTGRES_DATABASES.includes(database)) {
      throw new Error(`Unknown database "${database}". Available: ${POSTGRES_DATABASES.join(', ')}`);
    }

    // Block dangerous patterns
    const blocked = ['DROP DATABASE', 'DROP SCHEMA', 'TRUNCATE'];
    for (const b of blocked) {
      if (sql.toUpperCase().includes(b)) {
        throw new Error(`Blocked SQL pattern: "${b}". Use a more targeted operation.`);
      }
    }

    const escapedSql = sql.replace(/'/g, "'\\''");
    const pw = operatorPgPassword();
    const output = runKubectl(
      `exec ${POSTGRES_PRIMARY_POD} -c postgres -n platform -- env PGPASSWORD='${pw}' psql -U ${OPERATOR_PG_USER} -d ${database} -h localhost -c '${escapedSql}'`,
      30_000,
    );

    return { database, sql, output };
  },
};
