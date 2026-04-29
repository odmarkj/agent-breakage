import { spawn, execSync } from 'node:child_process';
import { createWriteStream, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import type { ToolDefinition } from '../types.js';

// Track spawned fix processes
const activeFixes = new Map<string, {
  pid: number;
  service: string;
  workDir: string;
  githubRepo: string;
  logFile: string;
  startedAt: number;
}>();

function generateFixId(): string {
  return `fix_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildPrompt(diagnosis: string, logSnippet: string): string {
  return `You are fixing a production bug detected by the k3s operator (Emily).

## Diagnosis
${diagnosis}

## Error Logs
${logSnippet}

## Rules
- ONLY fix obvious bugs: typos, wrong variable names, null references, missing imports, off-by-one errors
- Do NOT change business logic, algorithms, or feature behavior
- Do NOT add new features or refactor surrounding code
- The fix should be 1-5 lines of changed code maximum
- If the fix requires more than 5 lines or touches business logic, do NOT make changes — instead write to stdout: "EMILY_NEEDS_HUMAN: <reason>"

## Instructions
1. Read the relevant source files to understand the bug
2. Fix the bug
3. Run tests if they exist (npm test, pytest, etc.) — skip if no test infrastructure
4. Commit with message: "fix: <description> [emily-autofix]"
5. Push to main
`;
}

function cleanupWorkDir(fixId: string): void {
  const workDir = `/app/workspace/${fixId}`;
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch { /* ignore cleanup errors */ }
}

export const spawnCodeFix: ToolDefinition = {
  name: 'spawn_code_fix',
  description:
    'Spawn a Claude Code session to fix an application-level bug. Clones the service repo, runs Claude to diagnose and fix the bug, then commits and pushes. Use when investigation reveals a code bug that restarts/scaling cannot fix. Check status with check_code_fix.',
  tier: 2,
  reversibility: 0.7,
  adminOnly: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      service: {
        type: 'string',
        description: 'Service name (e.g., "advocate", "ai-writer")',
      },
      githubRepo: {
        type: 'string',
        description: 'GitHub repo in owner/name format (e.g., "odmarkj/ai-advocate")',
      },
      diagnosis: {
        type: 'string',
        description: 'Your root-cause analysis of the bug',
      },
      logSnippet: {
        type: 'string',
        description: 'Relevant error logs and stack traces',
      },
    },
    required: ['service', 'githubRepo', 'diagnosis', 'logSnippet'],
  },
  async execute(input) {
    const service = input.service as string;
    const githubRepo = input.githubRepo as string;
    const diagnosis = input.diagnosis as string;
    const logSnippet = input.logSnippet as string;

    // Check for concurrent fixes (limit to 1 at a time)
    for (const [id, fix] of activeFixes) {
      if (isProcessRunning(fix.pid)) {
        return {
          status: 'rejected',
          reason: `Another code fix is already running: ${id} for ${fix.service}`,
        };
      }
    }

    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN not configured — cannot clone repos');
    }

    const fixId = generateFixId();
    const workDir = `/app/workspace/${fixId}`;
    const logFile = `/tmp/emily-fix-${fixId}.log`;

    // Clone the repo
    mkdirSync(workDir, { recursive: true });
    try {
      execSync(
        `git clone --depth 1 https://x-access-token:${token}@github.com/${githubRepo}.git ${workDir}`,
        { timeout: 60_000, stdio: 'pipe' },
      );
    } catch (err) {
      cleanupWorkDir(fixId);
      throw new Error(`Failed to clone ${githubRepo}: ${(err as Error).message?.replace(token, '***')}`);
    }

    // Configure git for commits and set ownership for emily user
    execSync('git config user.name "Emily (k3s-operator)"', { cwd: workDir });
    execSync('git config user.email "emily@ldex.co"', { cwd: workDir });
    execSync(`chown -R emily:emily ${workDir}`, { timeout: 30_000 });

    // Build prompt and write runner script
    const prompt = buildPrompt(diagnosis, logSnippet);
    const promptFile = `/tmp/emily-fix-${fixId}.txt`;
    writeFileSync(promptFile, prompt, 'utf-8');

    // Write a runner script to avoid shell escaping issues
    const scriptFile = `/tmp/emily-fix-${fixId}.sh`;
    writeFileSync(scriptFile, [
      '#!/bin/bash',
      `cd ${workDir}`,
      `export ANTHROPIC_API_KEY="${process.env.ANTHROPIC_API_KEY}"`,
      `export GH_TOKEN="${token}"`,
      `export HOME=/home/emily`,
      `claude -p "$(cat ${promptFile})" --dangerously-skip-permissions`,
    ].join('\n'), 'utf-8');
    execSync(`chmod +x ${scriptFile}`);

    // Spawn claude as non-root emily user (Claude CLI refuses --dangerously-skip-permissions as root)
    const child = spawn('su', ['-s', '/bin/bash', 'emily', '-c', scriptFile], {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    // Pipe output to log file
    const logStream = createWriteStream(logFile);
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);

    child.unref();

    activeFixes.set(fixId, {
      pid: child.pid!,
      service,
      workDir,
      githubRepo,
      logFile,
      startedAt: Date.now(),
    });

    return {
      fixId,
      status: 'spawned',
      service,
      githubRepo,
      logFile,
      pid: child.pid,
      message: `Cloned ${githubRepo} and spawned Claude Code session. Use check_code_fix with fixId "${fixId}" to monitor progress.`,
    };
  },
};

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const checkCodeFix: ToolDefinition = {
  name: 'check_code_fix',
  description:
    'Check the status of a spawned code fix session. Returns whether the Claude session is still running, its recent output, and the latest git commit if one was made.',
  tier: 1,
  reversibility: 0.0,
  adminOnly: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      fixId: {
        type: 'string',
        description: 'The fix ID returned by spawn_code_fix',
      },
    },
    required: ['fixId'],
  },
  async execute(input) {
    const fixId = input.fixId as string;
    const fix = activeFixes.get(fixId);

    if (!fix) {
      return { status: 'unknown', error: `No fix found with ID "${fixId}"` };
    }

    const running = isProcessRunning(fix.pid);
    const elapsed = Math.round((Date.now() - fix.startedAt) / 1000);

    // Read last 50 lines of log
    let lastOutput = '';
    if (existsSync(fix.logFile)) {
      try {
        const content = readFileSync(fix.logFile, 'utf-8');
        const lines = content.split('\n');
        lastOutput = lines.slice(-50).join('\n');
      } catch { /* ignore read errors */ }
    }

    // Check for recent commit with autofix marker
    let latestCommit: string | undefined;
    let pushed = false;
    try {
      latestCommit = execSync('git log --oneline -1', {
        cwd: fix.workDir,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      if (latestCommit.includes('[emily-autofix]')) {
        pushed = true;
      }
    } catch { /* ignore git errors */ }

    // Check if Claude determined it needs a human
    let needsHuman = false;
    if (lastOutput.includes('EMILY_NEEDS_HUMAN')) {
      needsHuman = true;
    }

    const status = running ? 'running' : (needsHuman ? 'needs_human' : 'completed');

    // Clean up workspace when done
    if (!running) {
      cleanupWorkDir(fixId);
      activeFixes.delete(fixId);
    }

    return {
      fixId,
      status,
      service: fix.service,
      githubRepo: fix.githubRepo,
      pid: fix.pid,
      elapsedSeconds: elapsed,
      running,
      pushed,
      needsHuman,
      lastOutput: lastOutput.slice(-2000),
      latestCommit,
    };
  },
};

export const checkCIStatus: ToolDefinition = {
  name: 'check_ci_status',
  description:
    'Check the latest GitHub Actions CI run status for a repo. Use after a code fix is pushed to monitor the build.',
  tier: 1,
  reversibility: 0.0,
  adminOnly: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      githubRepo: {
        type: 'string',
        description: 'GitHub repo in owner/name format (e.g., "odmarkj/ai-advocate")',
      },
    },
    required: ['githubRepo'],
  },
  async execute(input) {
    const repo = input.githubRepo as string;
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN not configured');
    }

    const result = execSync(
      `gh run list --repo ${repo} --limit 1 --json status,conclusion,headBranch,event,createdAt`,
      { encoding: 'utf-8', timeout: 15_000, env: { ...process.env, GH_TOKEN: token } },
    );
    return JSON.parse(result);
  },
};
