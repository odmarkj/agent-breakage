import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolDefinition } from '../types.js';

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

function runHelm(args: string, timeout = 15_000): string {
  return execSync(`helm ${args}`, {
    encoding: 'utf-8',
    timeout,
    maxBuffer: 1024 * 1024,
    env: kubectlEnv(),
  }).trim();
}

function sanitizeName(name: string): string {
  if (!/^[a-zA-Z0-9._/-]+$/.test(name)) {
    throw new Error(`Invalid name: "${name}"`);
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

export const helmList: ToolDefinition = {
  name: 'helm_list',
  description: 'List all Helm releases across all namespaces.',
  tier: 1,
  reversibility: 0.0,
  adminOnly: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      namespace: {
        type: 'string',
        description: 'Namespace to list releases in (omit for all)',
      },
    },
    required: [],
  },
  async execute(input) {
    const ns = input.namespace as string | undefined;
    let cmd = 'list';
    if (ns) {
      cmd += ` -n ${sanitizeNamespace(ns)}`;
    } else {
      cmd += ' --all-namespaces';
    }
    return { output: runHelm(cmd) };
  },
};

export const helmStatus: ToolDefinition = {
  name: 'helm_status',
  description: 'Show the status of a Helm release including deployed resources.',
  tier: 1,
  reversibility: 0.0,
  adminOnly: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      release: {
        type: 'string',
        description: 'Release name',
      },
      namespace: {
        type: 'string',
        description: 'Namespace',
      },
    },
    required: ['release', 'namespace'],
  },
  async execute(input) {
    const release = sanitizeName(input.release as string);
    const ns = sanitizeNamespace(input.namespace as string);
    return { output: runHelm(`status ${release} -n ${ns}`) };
  },
};

export const helmHistory: ToolDefinition = {
  name: 'helm_history',
  description: 'Show the revision history of a Helm release.',
  tier: 1,
  reversibility: 0.0,
  adminOnly: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      release: {
        type: 'string',
        description: 'Release name',
      },
      namespace: {
        type: 'string',
        description: 'Namespace',
      },
    },
    required: ['release', 'namespace'],
  },
  async execute(input) {
    const release = sanitizeName(input.release as string);
    const ns = sanitizeNamespace(input.namespace as string);
    return { output: runHelm(`history ${release} -n ${ns}`) };
  },
};

// ── Tier 3: Destructive, requires approval ──────────────────────────

export const helmUpgrade: ToolDefinition = {
  name: 'helm_upgrade',
  description:
    'Upgrade a Helm release. REQUIRES APPROVAL. Can install if not present (--install flag).',
  tier: 3,
  reversibility: 1.0,
  adminOnly: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      release: {
        type: 'string',
        description: 'Release name',
      },
      chart: {
        type: 'string',
        description: 'Chart reference (e.g., bitnami/postgresql, ./charts/myapp)',
      },
      namespace: {
        type: 'string',
        description: 'Namespace',
      },
      values: {
        type: 'string',
        description: 'YAML values to pass (inline)',
      },
      set: {
        type: 'string',
        description: 'Comma-separated key=value pairs (e.g., "image.tag=v1.2,replicas=3")',
      },
      install: {
        type: 'boolean',
        description: 'Install if release does not exist (default: true)',
      },
    },
    required: ['release', 'chart', 'namespace'],
  },
  async execute(input) {
    const release = sanitizeName(input.release as string);
    const chart = sanitizeName(input.chart as string);
    const ns = sanitizeNamespace(input.namespace as string);
    const install = (input.install as boolean) ?? true;
    const setValues = input.set as string | undefined;

    let cmd = `upgrade ${release} ${chart} -n ${ns}`;
    if (install) cmd += ' --install';
    if (setValues) {
      // Validate set values format
      for (const pair of setValues.split(',')) {
        if (!pair.includes('=')) throw new Error(`Invalid set value: "${pair}"`);
      }
      cmd += ` --set ${setValues}`;
    }

    // TODO: support --values with inline YAML via temp file

    return { output: runHelm(cmd, 120_000) };
  },
};

export const helmRollback: ToolDefinition = {
  name: 'helm_rollback',
  description: 'Rollback a Helm release to a previous revision. REQUIRES APPROVAL.',
  tier: 3,
  reversibility: 1.0,
  adminOnly: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      release: {
        type: 'string',
        description: 'Release name',
      },
      namespace: {
        type: 'string',
        description: 'Namespace',
      },
      revision: {
        type: 'number',
        description: 'Revision number to rollback to (omit for previous)',
      },
    },
    required: ['release', 'namespace'],
  },
  async execute(input) {
    const release = sanitizeName(input.release as string);
    const ns = sanitizeNamespace(input.namespace as string);
    const revision = input.revision as number | undefined;

    let cmd = `rollback ${release}`;
    if (revision !== undefined) cmd += ` ${revision}`;
    cmd += ` -n ${ns}`;

    return { output: runHelm(cmd, 60_000) };
  },
};
