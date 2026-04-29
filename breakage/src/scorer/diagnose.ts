/**
 * Diagnosis-axis scoring. See plan §3, §12.
 *
 *   primary match   → 0.7 of diagnosis credit
 *   primary near-miss → 0.35 (half) of diagnosis credit
 *   each secondary  → 0.1 (capped at 0.3 total across secondaries)
 *
 * A "near-miss" is when Emily's primary_category appears in the
 * ground_truth's secondary_categories list (the scenario author
 * declared the pick as an acceptable alternate), OR when the
 * ground_truth's primary appears in Emily's secondary_categories
 * list (she thought of it, just didn't rank it first). The 2026-04-23
 * anchor-fail audit found that most sub-threshold anchors were pulled
 * down by effect-vs-cause category overlap — Emily's prose correctly
 * names the cause but she picks the effect category. Near-miss credit
 * rewards this kind of reasoning without awarding full credit for a
 * miss.
 *
 * Result is a fraction in [0, 1] representing how much of the
 * diagnosis-axis credit Emily earned. The caller multiplies by the
 * scenario's `credits.diagnosed` weight.
 */

import type { GroundTruth } from '../types/index.js';

export interface DiagnoseInputs {
  groundTruth: GroundTruth;
  /** From Emily's postmortem. */
  claimedPrimary: string;
  /** From Emily's postmortem. May be empty. */
  claimedSecondaries: string[];
}

export interface DiagnoseResult {
  primaryMatch: boolean;
  /**
   * True when Emily's primary didn't match the ground_truth's primary
   * exactly, but there's category overlap via the secondaries list
   * on either side. Documents why the score isn't zero.
   */
  primaryNearMiss: boolean;
  secondaryMatches: string[];
  /** 0 to 1 inclusive. */
  score: number;
}

export function scoreDiagnose(inputs: DiagnoseInputs): DiagnoseResult {
  const primaryMatch = inputs.groundTruth.primary_category === inputs.claimedPrimary;

  const truthSecondaries = new Set(inputs.groundTruth.secondary_categories);
  const claimedSecondaries = new Set(inputs.claimedSecondaries);
  const secondaryMatches: string[] = [];
  for (const s of truthSecondaries) {
    if (claimedSecondaries.has(s)) secondaryMatches.push(s);
  }

  // Primary-axis credit.
  //   0.70 — exact primary match
  //   0.35 — near-miss: Emily's primary is in ground_truth.secondaries,
  //          or ground_truth.primary is in Emily's secondaries
  //   0.00 — no primary overlap
  let primaryScore: number;
  let primaryNearMiss = false;
  if (primaryMatch) {
    primaryScore = 0.7;
  } else if (
    truthSecondaries.has(inputs.claimedPrimary) ||
    claimedSecondaries.has(inputs.groundTruth.primary_category)
  ) {
    primaryScore = 0.35;
    primaryNearMiss = true;
  } else {
    primaryScore = 0;
  }

  // Secondaries are 0.1 each, capped at 0.3.
  const secondaryScore = Math.min(0.3, secondaryMatches.length * 0.1);

  return {
    primaryMatch,
    primaryNearMiss,
    secondaryMatches,
    score: primaryScore + secondaryScore,
  };
}
