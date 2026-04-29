import { readFileSync, readdirSync, watch } from 'node:fs';
import { resolve, extname } from 'node:path';

/**
 * Stable memory: loaded from files in the context/ directory.
 * Contains cluster topology, service inventory, SOPs, escalation policies.
 * Read at startup, reloaded on file change.
 */

let _cache: Map<string, string> = new Map();
let _contextDir: string;

export function initStableMemory(contextDir?: string): void {
  _contextDir = contextDir ?? resolve(process.cwd(), '..', 'context');
  reload();

  // Watch for changes
  try {
    watch(_contextDir, { recursive: true }, (_eventType, filename) => {
      if (filename && extname(filename) === '.md') {
        reload();
      }
    });
  } catch {
    // watch may not be supported, that's fine
  }
}

function reload(): void {
  _cache.clear();
  try {
    const files = readdirSync(_contextDir);
    for (const file of files) {
      if (extname(file) !== '.md') continue;
      try {
        const content = readFileSync(resolve(_contextDir, file), 'utf-8');
        _cache.set(file.replace('.md', ''), content);
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // context dir doesn't exist yet
  }
}

/** Get all stable memory as a single string for system prompt injection */
export function getStableContext(): string {
  if (_cache.size === 0) return '';
  const sections: string[] = [];
  for (const [name, content] of _cache) {
    sections.push(`### ${name}\n${content}`);
  }
  return sections.join('\n\n');
}

/** Get a specific stable memory document */
export function getStableDoc(name: string): string | undefined {
  return _cache.get(name);
}

/** List all stable memory documents */
export function listStableDocs(): string[] {
  return [..._cache.keys()];
}
