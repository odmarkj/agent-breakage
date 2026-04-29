# Corpus-density sweep — 2026-04-28

The publication-quality version of the [2026-04-24 falsification test](falsification-test-2026-04-24.md). Tightens the central finding by adding a third axis (corpus density), running on Sonnet 4.6 instead of Haiku 4.5, and pre-registering the per-scenario × per-density-tier comparison.

## Question

The falsification test established that retrieval over past postmortems has a small-but-real positive effect on the densest-corpus scenario tested (`secret-missing-key`, n=20, +0.058 p<0.05) and weak signal elsewhere. The follow-on hypothesis: *retrieval's effect grows with the per-scenario corpus density of near-neighbors*. The sweep tests this directly by manipulating the candidate-pool size at retrieval time.

## Method

**Scenarios** (3): `secret-missing-key-advocate`, `liveness-probe-always-fails-advocate`, `cpu-limit-throttling-advocate`. Picked to span the prior result's significant / null / near-significant findings.

**Density tiers** (3): `poolCap=5`, `poolCap=15`, and full-corpus (no cap). Implemented as a new `BREAKAGE_RETRIEVAL_POOL_CAP` knob in `breakage/src/experience-base/retrieval.ts`. The cap is applied at the SQL `LIMIT` level, before the existing distance threshold and final k-cap. At `poolCap=5`, retrieval has access to only the top-5 nearest postmortems for each query — simulating the experience of an agent operating against a sparse corpus.

**Arms** (2 per cell): TEI (real `bge-m3` semantic retrieval) vs. control (`BREAKAGE_EMBEDDER=deterministic`, semantically random; combined with the threshold filter all results are dropped, so the agent sees no retrieval). The control arm is a true *retrieval-off* condition, not "retrieval with noise."

**Reps**: 20 per cell. Total: 3 × 3 × 2 × 20 = **360 runs**.

**Model**: Sonnet 4.6 (`claude-sonnet-4-6`). All other Emily configuration matches production: tier-3 synthetic approver, 600s scenario time budget, HNSW index, distance threshold 0.40.

**Wall clock**: 26h 16min from launch (2026-04-27 12:26 PDT) to completion (2026-04-28 14:42 PDT). Sequential execution; one runner restart per cell.

## Results

### Per-scenario × density

| Scenario | Density | n_tei | μ_tei | σ_tei | n_ctrl | μ_ctrl | σ_ctrl | Δ | t | sig |
|---|---|---|---|---|---|---|---|---|---|---|
| `cpu-limit-throttling-advocate` | 5 | 20 | 0.722 | 0.091 | 20 | 0.763 | 0.097 | −0.041 | −1.39 | ns |
| `cpu-limit-throttling-advocate` | 15 | 20 | 0.671 | 0.115 | 20 | 0.676 | 0.113 | −0.005 | −0.15 | ns |
| `cpu-limit-throttling-advocate` | full | 20 | 0.655 | 0.095 | 20 | 0.723 | 0.131 | **−0.068** | **−1.87** | ns (close) |
| `liveness-probe-always-fails-advocate` | 5 | 20 | 0.705 | 0.210 | 20 | 0.788 | 0.194 | −0.084 | −1.31 | ns |
| `liveness-probe-always-fails-advocate` | 15 | 20 | 0.705 | 0.210 | 20 | 0.725 | 0.209 | −0.020 | −0.31 | ns |
| `liveness-probe-always-fails-advocate` | full | 20 | 0.746 | 0.206 | 20 | 0.670 | 0.214 | +0.076 | +1.14 | ns |
| `secret-missing-key-advocate` | 5 | 20 | 0.884 | 0.058 | 20 | 0.790 | 0.113 | **+0.094** | **+3.31** | **p<0.01** |
| `secret-missing-key-advocate` | 15 | 20 | 0.863 | 0.080 | 20 | 0.780 | 0.141 | **+0.083** | **+2.28** | **p<0.05** |
| `secret-missing-key-advocate` | full | 20 | 0.894 | 0.038 | 20 | 0.785 | 0.140 | **+0.109** | **+3.36** | **p<0.01** |

### Pooled by density tier

| Density | n_tei | μ_tei | σ_tei | n_ctrl | μ_ctrl | σ_ctrl | Δ | t | sig |
|---|---|---|---|---|---|---|---|---|---|
| 5 | 60 | 0.770 | 0.157 | 60 | 0.781 | 0.139 | −0.010 | −0.38 | ns |
| 15 | 60 | 0.746 | 0.166 | 60 | 0.727 | 0.163 | +0.019 | +0.63 | ns |
| full | 60 | 0.765 | 0.164 | 60 | 0.726 | 0.170 | +0.039 | +1.28 | ns |

## Findings

### Per-scenario heterogeneity dominates per-density variance

The most striking feature of the data is the variance *across scenarios*, not across density tiers. For `secret-missing-key` retrieval helps significantly at every density tier (Δ ranging from +0.083 to +0.109, all p<0.05). For `cpu-throttling` retrieval *hurts* at every density tier (Δ ranging from −0.005 to −0.068, with the full-density arm trending toward significance). For `liveness-probe` the effect is essentially noise.

The pooled per-density numbers — the headline result the original hypothesis predicted — *do* trend monotonically: −0.010, +0.019, +0.039 from sparse to full. But none reach statistical significance at n=60 per tier. The pooled trend is being pulled along by `secret-missing-key`'s strong positive effect and dampened by `cpu-throttling`'s consistent negative.

### `secret-missing-key`: retrieval works, density barely matters

For this scenario class, retrieval delivers a substantial positive effect (+0.083 to +0.109) at every density tier. The effect is statistically significant at p<0.05 even with `poolCap=5` — meaning Emily benefits from access to as few as 5 near-neighbor postmortems.

The mechanism: secret-missing-key has many direct precedents in the corpus (48+ postmortems with `primary_category=secret-content-mismatch`). The 5 nearest are all direct-precedent same-category resolved postmortems. Even at the most-restrictive density tier, the 5 things Emily sees are all useful.

**Interpretation**: when the corpus has *direct mechanistic precedents* for a scenario, retrieval reliably helps. The minimum useful density is small (5 near-neighbors).

### `cpu-throttling`: retrieval *hurts*, and the harm grows with density

This is the most important finding because it contradicts the strong version of the binding-constraint hypothesis. We expected retrieval to help less at low density and more at high density. For cpu-throttling, the *direction is reversed*:

- At `poolCap=5`: −0.041 (control wins)
- At `poolCap=15`: −0.005 (tied)
- At `poolCap=full`: **−0.068, t=−1.87** (TEI loses, close to significance)

What's happening: cpu-throttling's `primary_category` is `resource-limit-misconfiguration`, but most of the corpus's `resource-limit-misconfiguration` postmortems are about *memory* (OOM scenarios). The 5 nearest postmortems for a cpu-throttling query are mostly OOM-fix postmortems — semantically nearby, mechanistically wrong.

At higher density tiers, *more* OOM postmortems make it through to Emily's prompt. She over-anchors on the "raise memory limit" pattern and applies it to a CPU problem. More retrieval, more confused.

This is a known failure mode of dense-corpus retrieval when the corpus is *unbalanced within a category*. The retrieval mechanism doesn't distinguish memory-OOM from CPU-throttling at the embedding layer — both are "container-resource-limit incidents." The agent has to disambiguate from the prose, and apparently doesn't reliably.

**Interpretation**: retrieval's effect depends not just on per-scenario *density* but on per-scenario *mechanistic alignment*. A category with high count but low alignment (memory-OOM dominating cpu-throttling's near neighbors) actively misleads.

### `liveness-probe`: high variance, weak signal, U-shape across density

Pattern: −0.084 at low density, −0.020 at medium, +0.076 at full. None significant. Both arms have very high standard deviation (σ ≈ 0.21) — large within-arm variability is the dominant feature.

The likely cause is the time-budget-stub pattern. Liveness-probe scenarios time out at the 600s budget more often than other scenarios (the agent fails to converge on a fix). Timed-out runs score as the framework-stub default of 0.5. This produces a bimodal distribution: ~0.91 on successful runs, ~0.5 on timeouts. With ~half the runs in each mode, the cell mean lands near 0.7 with high variance.

**Interpretation**: this scenario is too noisy at the current 600s budget to detect any but the largest retrieval effects. The dose-response trend (-0.084 → +0.076 across densities) is suggestive of the same "more density helps" hypothesis but the test is underpowered to confirm.

## What this means for the binding-constraint claim

The original framing (from the falsification report and the corpus-seed-verify report) was: *retrieval works conditional on per-scenario corpus density. Sparse corpora hurt; dense corpora help.* This sweep refines that claim:

1. **Per-scenario heterogeneity dominates.** Some scenarios benefit from retrieval at any density (`secret-missing-key`); others are hurt at any density (`cpu-throttling`); others are noise-dominated. Per-scenario variance is bigger than per-density-tier variance.

2. **Density alone is not sufficient.** Pooled effect grows with density (−0.010 → +0.019 → +0.039) but doesn't reach significance even at n=60 per tier. The pooled trend is *dominated* by `secret-missing-key`'s strong positive contribution. Removing that scenario from the pool would invert the conclusion.

3. **Mechanistic alignment matters at least as much as count.** `cpu-throttling`'s corpus-density problem is qualitatively different from `secret-missing-key`'s. Both have many `resource-limit-misconfiguration` postmortems globally, but only secret-missing-key has direct same-mechanism near-neighbors. The retrieval mechanism doesn't surface that distinction; it would need a category-aware (or mechanism-aware) embedding scheme to do so.

4. **The 600s time budget is a confounder for some scenarios.** liveness-probe's high variance suggests the test was underpowered. A future tightening would either raise the budget specifically for that scenario or address the underlying convergence problem in the agent.

## Compared to the falsification test

The 2026-04-24 falsification result on n=20 per arm:

| Scenario | Sweep (Sonnet 4.6, full density) | Falsification (Haiku 4.5, full density) |
|---|---|---|
| secret-missing-key | +0.109 (p<0.01) | +0.058 (p<0.05) |
| cpu-throttling | −0.068 (ns, t=−1.87) | +0.091 (ns, t=+1.82) |
| liveness-probe / readiness-probe | +0.076 (ns) | −0.032 (ns) |

Key differences:
- **Sonnet 4.6 amplifies the positive effect on `secret-missing-key`** (+0.109 vs +0.058). Suggests Sonnet uses retrieved exemplars more effectively when they're mechanistically aligned.
- **The cpu-throttling sign flipped** (+0.091 → −0.068). Sonnet appears to over-anchor on cross-mechanism precedents in a way Haiku didn't, at least for this scenario class.
- **Liveness vs readiness**: different scenarios; high variance in both prevents conclusions.

The falsification's pooled +0.039 (n=60) was numerically identical to this sweep's pooled at full density (+0.039). The framing changes (Sonnet sharpens within-scenario effects, both directions; the per-scenario picture is more bimodal at Sonnet) but the bottom-line pooled effect size is the same.

## Implications

For Phase-0 closeout: **the retrieval-compounding mechanism is real for a specific scenario class but not the others tested**. The strong version of the binding-constraint hypothesis (density alone matters) is partially falsified — density matters but mechanistic alignment matters more, and the corpus's per-mechanism balance affects whether retrieval helps or hurts.

For the next-phase decision (whether to invest in literature-driven corpus growth):
- **Yes for densifying corpus-aligned scenarios.** Where the corpus already has direct precedents, more is more. `secret-missing-key`'s ceiling at full density (μ=0.894) is well above the same-arm at low density (μ=0.884), with σ shrinking from 0.058 → 0.038.
- **No for densifying corpus-misaligned scenarios.** Adding more memory-OOM postmortems to a corpus that already overweights them won't help cpu-throttling; it'll make it worse. Targeted, mechanistically-aligned authoring is needed, not breadth.

For external citation: cite the *per-scenario × density* table, not the pooled. The pooled headline number (+0.039 ns) understates the secret-missing-key effect and overstates the others. Per-scenario reporting is the honest representation.

## What this experiment did not establish

- **Whether the cpu-throttling negative effect would invert with mechanistically-aligned authoring.** A natural follow-on: seed 5+ cpu-throttling postmortems (as opposed to memory-OOM) into the corpus, re-run the sweep on cpu-throttling alone, see if the effect flips positive.
- **Whether `liveness-probe`'s high variance can be reduced.** Investigation of the time-budget-stub pattern suggests either raising the budget (longer runs, more cost) or addressing the convergence issue in the agent's reasoning loop.
- **Generalizability beyond the 3 scenarios tested.** The corpus has ~24 categories; this sweep tested only 3 scenarios across them. The bimodal pattern (helps / hurts / noise-dominated) might be scenario-class-specific.

These are next-phase concerns. The Phase-0 result stands as: *retrieval has scenario-specific effects of meaningful magnitude. Single-scalar generalizations across scenarios obscure the actual mechanism.*

## Reproducibility

The full manifest is at `/tmp/density-sweep-manifest.csv` (will be archived to `breakage/reports/data/` as part of Phase-0 closeout). Re-run with:

```bash
bash breakage/scripts/density-sweep.sh
```

(Defaults: 3 scenarios × 3 densities × 2 arms × 20 reps. Override via `REPS`, `SCENARIOS`, `OPERATOR_MODEL` env vars.)

Per-cell raw scores in the manifest CSV. Statistical analysis via:

```bash
python3 breakage/scripts/analyze-density-sweep.py /tmp/density-sweep-manifest.csv
```

(no external dependencies — uses Python stdlib `statistics`).
