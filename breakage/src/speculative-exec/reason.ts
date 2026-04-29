/**
 * Mechanical revert-reason formatter.
 *
 * The controller emits a mechanical reason string when auto-revert
 * fires — the metric-level observation that triggered revert.
 * Semantic analysis (*why* the metric moved) is Emily's job on her
 * next cycle; she reads this string plus the retrieval context and
 * produces the semantic update in her next postmortem.
 *
 * Right split of responsibility: controller doesn't need a theory of
 * the system, Emily does. Keep this file dumb and deterministic.
 */

import type { SloMetricDelta } from './types.js';

export function formatMechanicalReason(delta: SloMetricDelta): string {
  const before = formatValue(delta.before);
  const after = formatValue(delta.after);
  const diff = formatValue(delta.delta);
  const threshold = formatValue(delta.threshold);

  const since = timeSince(delta.exceededAt);

  return (
    `${delta.metric} moved from ${before} to ${after} within ${since} ` +
    `of your mutation (delta ${diff}, exceeding regression threshold ${threshold}). ` +
    `Reverted via snapshot.`
  );
}

function formatValue(v: number): string {
  if (Number.isInteger(v)) return String(v);
  if (Math.abs(v) < 0.01) return v.toExponential(2);
  return v.toFixed(3);
}

function timeSince(iso: string): string {
  // The controller tracks a known "mutationAt" separately; here we
  // just report a human-readable timestamp. The caller can prepend
  // a more specific elapsed-time string if it knows the mutation
  // time.
  return new Date(iso).toISOString();
}
