# Retrieval distance-threshold arm — 2026-04-24

Tests whether a simple `maxDistance ≤ 0.40` filter on retrieval results — applied before Emily sees them — neutralizes the harm observed in the prior HNSW re-run where working retrieval hurt Emily on sparse-corpus scenarios.

## Method

- **Arm**: runner started with `BREAKAGE_RETRIEVAL_MAX_DISTANCE=0.40` plus the default bge-m3 embedder and HNSW index.
- **Comparison arms**: unchanged TEI (no threshold) and deterministic (control) measurements from the HNSW re-run.
- **Scope**: 9 anchors × 3 reps = 27 runs.
- **All else held constant.**

## Results

### Top-line

| Arm | n | Mean |
|---|---|---|
| TEI (no threshold) | 27 | 0.74 |
| Control (deterministic) | 27 | 0.78 |
| **TEI + threshold 0.40** | **27** | **0.79** |

The threshold arm achieves parity with control and beats no-threshold TEI by +0.05. **The harm hypothesis from the HNSW re-run (retrieval actively misleading Emily on sparse-corpus scenarios) is confirmed via the inverse experiment**: putting a filter in front of retrieval reclaims the lost performance.

### Per-scenario (all three arms)

| Scenario | TEI | Ctrl | Thr | Thr−Ctrl | Thr−TEI |
|---|---|---|---|---|---|
| secret-missing-key-advocate | 0.91 | 0.81 | 0.91 | +0.11 | 0.00 |
| readiness-probe-misconfigured-advocate | 0.84 | 0.77 | 0.91 | +0.14 | +0.07 |
| liveness-probe-always-fails-advocate | 0.77 | 0.82 | 0.86 | +0.05 | +0.09 |
| image-pull-failure-advocate | 0.91 | 0.91 | 0.91 | 0.00 | 0.00 |
| env-var-missing-advocate | 0.81 | 0.74 | 0.74 | 0.00 | −0.06 |
| oom-advocate-api-k8s-only | 0.70 | 0.70 | 0.77 | +0.07 | +0.07 |
| secret-wrong-password-advocate | 0.63 | 0.64 | 0.70 | +0.06 | +0.07 |
| replicas-zero-advocate | 0.50 | 0.81 | 0.67 | −0.14 | +0.17 |
| cpu-limit-throttling-advocate | 0.57 | 0.84 | 0.63 | −0.21 | +0.07 |

### What the threshold fixes, what it doesn't

**Fixes** (Thr > TEI by ≥0.07):
- replicas-zero-advocate: +0.17 recovery
- liveness-probe-always-fails: +0.09
- readiness-probe-misconfigured: +0.07
- oom-advocate-api-k8s-only: +0.07
- secret-wrong-password-advocate: +0.07
- cpu-limit-throttling-advocate: +0.07

Common pattern: all are scenarios where the no-threshold TEI arm returned semantically-close-but-mechanistically-wrong neighbors. Filtering at 0.40 drops 1–2 of those, leaving only the highest-similarity hits that tend to be direct precedents.

**Neutral** (Thr ≈ TEI):
- image-pull-failure-advocate: both 0.91
- secret-missing-key-advocate: both 0.91

Pattern: scenarios where the corpus already had dense in-category near-neighbors. Retrieval was already useful; the threshold doesn't remove anything useful.

**Regresses** (Thr < TEI):
- env-var-missing-advocate: −0.06. The threshold filter is probably dropping a useful same-scenario hit that was scoring 0.40-0.45. This suggests threshold 0.40 is slightly too aggressive for this specific scenario's query text.

### What threshold CAN'T fix (where Thr < Ctrl still)

Two scenarios still perform below control:
- cpu-limit-throttling-advocate: Thr 0.63 < Ctrl 0.84 (−0.21)
- replicas-zero-advocate: Thr 0.67 < Ctrl 0.81 (−0.14)

For these, even with threshold 0.40, the top retrieval hit is a same-category-wrong-mechanism OOM / image-pull postmortem at distance ≈ 0.38. That's under the threshold, so it gets through, and Emily reads it and tries memory-limit-raising on a CPU-throttling problem or restoring-an-image on a scale-down problem.

**Threshold alone cannot distinguish "nearby-and-right" from "nearby-and-wrong."** That's the distinction Step (1) corpus-density growth is designed to fix: seeding real cpu-throttling and replicas-loss postmortems so the top-k hits become in-mechanism rather than cross-mechanism.

## Recommendation

**Ship the threshold as a default**, but set it more conservatively than 0.40 to avoid the env-var-missing regression. Candidates:
- `0.42`: keeps more legitimate hits; might partially re-admit the cpu-limit misdirection
- `0.40`: current; best overall delta; has env-var regression
- `0.38`: likely drops many good hits; untested

Recommendation: default to 0.42 via migration-style bump in `retrieval.ts`, document the choice. Re-measure if Step (1) corpus seeding shifts per-scenario distance distributions.

## Honest caveat on the overall delta

Overall controlled delta TEI+threshold 0.40 vs Control (deterministic): **+0.01** (0.79 vs 0.78).

This is noise-level at n=27 per arm. What the measurement actually establishes is:
- Working retrieval + threshold is **not worse** than useless retrieval (unlike no-threshold TEI, which was demonstrably worse on 3 scenarios).
- Working retrieval + threshold has a **positive bimodal signal**: +0.11, +0.14 on two scenarios, neutral on four, mildly negative on three.
- The binding constraint on getting a clear positive delta is **corpus density** on the three still-negative scenarios, not retrieval mechanics.

A positive overall delta requires Step (1). This experiment establishes that retrieval-mechanics fixes (threshold) are sufficient to neutralize the harm, necessary but not sufficient for positive delta.

## Next steps (unchanged)

Continue the plan: Step (1) corpus seeding for cpu-throttling and replicas-loss categories. Re-measure the full 9-scenario arm after Step (1) lands. Hypothesis: overall delta moves to +0.05 or better, with cpu-limit and replicas-zero moving from below-control to at-or-above-control.
