/**
 * Parse scenario mutation strings into dotted-path + value.
 *
 * Supported shapes (Phase 1):
 *   spec.template.spec.containers[0].resources.limits.memory = "32Mi"
 *   spec.replicas = 0
 *   spec.template.spec.containers[0].image = "nonexistent:v0"
 *   spec.template.spec.containers[0].env = []
 *
 * RHS is YAML-ish scalar (string, number, bool, null) or the empty
 * literal `[]` / `{}`. For more complex structures (arrays with
 * content, nested objects), write a dedicated injector type rather
 * than extending this parser.
 */

export interface ParsedMutation {
  /** Dotted + indexed path segments, already parsed. */
  path: PathSegment[];
  /** The raw right-hand-side value, parsed to its JS representation. */
  value: unknown;
}

export type PathSegment =
  | { kind: 'key'; name: string }
  | { kind: 'index'; index: number };

export function parseMutation(mutation: string): ParsedMutation {
  const eq = mutation.indexOf('=');
  if (eq === -1) {
    throw new Error(`mutation missing '=': ${mutation}`);
  }
  const lhs = mutation.slice(0, eq).trim();
  const rhs = mutation.slice(eq + 1).trim();

  return {
    path: parsePath(lhs),
    value: parseScalar(rhs),
  };
}

function parsePath(lhs: string): PathSegment[] {
  const out: PathSegment[] = [];
  let buf = '';
  for (let i = 0; i < lhs.length; i++) {
    const c = lhs[i];
    if (c === '.') {
      if (buf) {
        out.push({ kind: 'key', name: buf });
        buf = '';
      }
    } else if (c === '[') {
      if (buf) {
        out.push({ kind: 'key', name: buf });
        buf = '';
      }
      const end = lhs.indexOf(']', i);
      if (end === -1) throw new Error(`unbalanced '[' in path: ${lhs}`);
      const idxStr = lhs.slice(i + 1, end).trim();
      const idx = Number(idxStr);
      if (!Number.isInteger(idx) || idx < 0) {
        throw new Error(`invalid index '${idxStr}' in path: ${lhs}`);
      }
      out.push({ kind: 'index', index: idx });
      i = end;
    } else {
      buf += c;
    }
  }
  if (buf) out.push({ kind: 'key', name: buf });
  return out;
}

function parseScalar(rhs: string): unknown {
  // Quoted string
  if (
    (rhs.startsWith('"') && rhs.endsWith('"')) ||
    (rhs.startsWith("'") && rhs.endsWith("'"))
  ) {
    return rhs.slice(1, -1);
  }
  if (rhs === 'true') return true;
  if (rhs === 'false') return false;
  if (rhs === 'null') return null;
  // Empty collection literals. Without these, `env = []` fell through
  // to the bare-word branch and became the string "[]", which k8s
  // server-side apply rejected with "duplicate entries for key
  // [name=\"\"]" since the env field expects a list of named entries.
  if (rhs === '[]') return [];
  if (rhs === '{}') return {};
  const asNum = Number(rhs);
  if (!Number.isNaN(asNum) && rhs !== '') return asNum;
  // Bare word — treat as string.
  return rhs;
}

/**
 * Apply a parsed mutation to an arbitrary JSON-like object in place.
 * Intermediate keys must exist (we don't auto-create paths — the
 * mutation targets an existing field).
 */
export function applyMutation(obj: Record<string, unknown>, mutation: ParsedMutation): void {
  if (mutation.path.length === 0) {
    throw new Error('empty mutation path');
  }
  let cursor: unknown = obj;
  for (let i = 0; i < mutation.path.length - 1; i++) {
    const seg = mutation.path[i];
    cursor = stepInto(cursor, seg);
    if (cursor == null) {
      throw new Error(
        `mutation path diverged at segment ${i} (${formatPath(mutation.path.slice(0, i + 1))}): target is null/undefined`,
      );
    }
  }
  const last = mutation.path[mutation.path.length - 1];
  if (last.kind === 'key') {
    (cursor as Record<string, unknown>)[last.name] = mutation.value;
  } else {
    (cursor as unknown[])[last.index] = mutation.value;
  }
}

function stepInto(obj: unknown, seg: PathSegment): unknown {
  if (seg.kind === 'key') {
    return (obj as Record<string, unknown>)[seg.name];
  }
  return (obj as unknown[])[seg.index];
}

function formatPath(segs: PathSegment[]): string {
  let s = '';
  for (const seg of segs) {
    if (seg.kind === 'key') s += s ? '.' + seg.name : seg.name;
    else s += `[${seg.index}]`;
  }
  return s;
}
