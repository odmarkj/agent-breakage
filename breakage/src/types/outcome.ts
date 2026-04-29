/**
 * The outcome label recorded on every postmortem. Drives retrieval
 * framing (positive exemplar vs counterexample) and the Week-4
 * inverse-guardrail-mining query.
 */
export type Outcome = 'resolved' | 'regressed' | 'inconclusive';

export function isOutcome(value: unknown): value is Outcome {
  return value === 'resolved' || value === 'regressed' || value === 'inconclusive';
}
