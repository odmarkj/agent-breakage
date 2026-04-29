/**
 * Reversibility is a per-tool scalar Emily consults at inference speed
 * when choosing among candidate actions. It's independent of tier
 * gating: tier gates human/synthetic approval; reversibility informs
 * Emily's own risk reasoning.
 *
 * Four canonical buckets (see plan §9):
 *   0.0 — trivially reversible (read-only: describe, list, logs, top)
 *   0.3 — reversible-with-snapshot (patch, scale, restart, create —
 *         auto-reverted by the speculative-exec controller)
 *   0.7 — reversible-with-effort (rebuild from backup, manual restoration)
 *   1.0 — irreversible (secret content write, delete, certain Helm ops)
 *
 * Known Phase-1 limitation: reversibility is tool-only, not
 * tool × target × environment. A patch against a 10-replica production
 * Deployment is effectively a different reversibility class than the
 * same patch on a 1-replica dev deployment. Tracked in the plan as
 * Phase-2+ scope; don't retrofit in Phase 1.
 */
export type Reversibility = number;

export const REVERSIBILITY_TRIVIAL: Reversibility = 0.0;
export const REVERSIBILITY_SNAPSHOTTABLE: Reversibility = 0.3;
export const REVERSIBILITY_WITH_EFFORT: Reversibility = 0.7;
export const REVERSIBILITY_IRREVERSIBLE: Reversibility = 1.0;

export function isValidReversibility(v: number): boolean {
  return v >= 0 && v <= 1;
}

/**
 * Bucket a free-form reversibility scalar into the canonical label.
 * Used for reporting and for the `no_regressions` scoring weight.
 */
export function reversibilityBucket(v: Reversibility): 'trivial' | 'snapshottable' | 'with-effort' | 'irreversible' {
  if (v < 0.15) return 'trivial';
  if (v < 0.5) return 'snapshottable';
  if (v < 0.85) return 'with-effort';
  return 'irreversible';
}
