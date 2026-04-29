/**
 * Observed retrieval_used determination. See plan §11.
 *
 * Emily does NOT self-report which retrieved postmortems she actually
 * leveraged — that signal would be hallucination-prone. Instead, the
 * scorer compares her action sequence to each retrieved postmortem's
 * actions_taken and counts a retrieval "used" when the action-pattern
 * overlap exceeds a threshold.
 *
 * Similarity metric: asymmetric containment of the retrieval's tool
 * set inside Emily's tool set, plus an order bonus.
 *
 * Asymmetric (not Jaccard) because the question we care about is
 * "did Emily's action sequence include what the retrieval would have
 * suggested?" — a longer Emily sequence that *contains* every tool
 * the retrieval used should still count as "used", not be penalized
 * for also running extra diagnostics. Symmetric Jaccard drops below
 * threshold whenever Emily runs additional investigation tools that
 * the retrieved postmortem didn't, which is the opposite of the
 * behavior we want to incentivize (thorough investigation that
 * still incorporates prior-incident knowledge).
 *
 * The order bonus nudges toward sequences that follow the
 * retrieval's tool ordering rather than matching its set by
 * accident.
 */

import type { ActionRef } from '../types/index.js';

const MATCH_THRESHOLD = 0.5;

export interface RetrievalCandidate {
  /** The retrieved postmortem's ID. */
  id: string;
  /** That postmortem's action sequence. */
  actions: Pick<ActionRef, 'tool'>[];
}

export interface DetermineInputs {
  /** Emily's observed action sequence in the current incident. */
  emilyActions: Pick<ActionRef, 'tool'>[];
  /** What retrieval returned pre-action; all candidates scored. */
  retrieved: RetrievalCandidate[];
}

export function determineRetrievalUsed(inputs: DetermineInputs): string[] {
  const emilyTools = inputs.emilyActions.map((a) => a.tool);
  if (emilyTools.length === 0) return [];

  const used: string[] = [];

  for (const cand of inputs.retrieved) {
    const candTools = cand.actions.map((a) => a.tool);
    if (candTools.length === 0) continue;

    const containment = containmentSimilarity(candTools, emilyTools);
    const orderBonus = sequenceOrderBonus(emilyTools, candTools);
    const combined = containment + orderBonus;

    if (combined >= MATCH_THRESHOLD) {
      used.push(cand.id);
    }
  }

  return used;
}

// ── Metrics ─────────────────────────────────────────────────────────

/**
 * Jaccard over the sets of tool names. Independent of order. Kept
 * exported for tests and for potential future use where symmetric
 * similarity is appropriate.
 */
export function jaccardSimilarity<T>(a: T[], b: T[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Asymmetric containment: fraction of `needle`'s unique tools that
 * appear in `haystack`. Answers "did haystack include everything
 * needle did?" — independent of how much extra haystack ran.
 * Returns 0 when needle is empty (nothing to contain).
 */
export function containmentSimilarity<T>(needle: T[], haystack: T[]): number {
  const needleSet = new Set(needle);
  if (needleSet.size === 0) return 0;
  const haystackSet = new Set(haystack);
  let covered = 0;
  for (const x of needleSet) if (haystackSet.has(x)) covered += 1;
  return covered / needleSet.size;
}

/**
 * Order-sensitive bonus: 0 to 0.25. Measures whether Emily's actions
 * followed the same tool-ordering as the retrieved postmortem.
 * Uses longest-common-subsequence length over tool sequences.
 */
export function sequenceOrderBonus<T>(a: T[], b: T[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const lcs = longestCommonSubsequenceLength(a, b);
  const maxLen = Math.max(a.length, b.length);
  return (lcs / maxLen) * 0.25;
}

function longestCommonSubsequenceLength<T>(a: T[], b: T[]): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp[m][n];
}
