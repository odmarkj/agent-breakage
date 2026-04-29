import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { ToolDefinition } from '../types.js';

const ALLOWED_ROOTS = ['/workspaces/k3s', '/tmp', '/app/workspace'];

function isAllowedPath(filePath: string): boolean {
  const resolved = resolve(filePath);
  return ALLOWED_ROOTS.some((root) => resolved.startsWith(root));
}

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read the contents of a file. Restricted to project and temp directories.',
  tier: 1,
  reversibility: 0.0,
  adminOnly: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative file path',
      },
      lines: {
        type: 'number',
        description: 'Maximum lines to read (default: 200)',
      },
    },
    required: ['path'],
  },
  async execute(input) {
    const filePath = resolve(input.path as string);
    if (!isAllowedPath(filePath)) {
      throw new Error(`Access denied: "${filePath}" is outside allowed directories`);
    }

    const content = readFileSync(filePath, 'utf-8');
    const maxLines = (input.lines as number) ?? 200;
    const lines = content.split('\n').slice(0, maxLines);

    return {
      path: filePath,
      content: lines.join('\n'),
      truncated: content.split('\n').length > maxLines,
    };
  },
};

export const listFilesTool: ToolDefinition = {
  name: 'list_files',
  description: 'List files in a directory. Restricted to project and temp directories.',
  tier: 1,
  reversibility: 0.0,
  adminOnly: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Directory path',
      },
    },
    required: ['path'],
  },
  async execute(input) {
    const dirPath = resolve(input.path as string);
    if (!isAllowedPath(dirPath)) {
      throw new Error(`Access denied: "${dirPath}" is outside allowed directories`);
    }

    const entries = readdirSync(dirPath).map((name) => {
      const fullPath = resolve(dirPath, name);
      const stat = statSync(fullPath);
      return {
        name,
        type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.size,
      };
    });

    return { path: dirPath, entries };
  },
};
