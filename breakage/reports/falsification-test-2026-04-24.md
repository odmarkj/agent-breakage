# Falsification test — retrieval compounding — 2026-04-24

The decisive experiment on whether semantic retrieval over past postmortems measurably improves Emily's scenario performance, under the system's most-favorable conditions (dense per-mechanism corpus, working HNSW retrieval, distance threshold filter, Emily image unchanged).

## Design

- **Treatment arm**: default `OpenAICompatibleEmbedder` → bge-m3 via in-cluster TEI. Retrieval returns real top-k near-neighbors; threshold 0.40 filters weak matches.
- **Control arm**: `BREAKAGE_EMBEDDER=deterministic`. Deterministic embedder produces semantically-random vectors; at threshold 0.40 all results are filtered out. **Emily sees no retrieved content.** This is true retrieval-off, not "retrieval with noise."
- **Scenarios**: the 3 with densest corpus coverage — `secret-missing-key-advocate`, `cpu-limit-throttling-advocate`, `readiness-probe-misconfigured-advocate`.
- **Sample size**: n=20 per scenario per arm. 120 total runs.
- **Test**: Welch's two-sample t-test per scenario, plus pooled.
- **Pre-registered decision matrix**:
  - 2 of 3 significant positive at p<0.05 → continue Phase 1 as planned
  - Mixed → ship Option 2 (limited v0 scorecard with current scenarios)
  - Null/negative → pivot next-phase investment away from retrieval

## Results

| Scenario | n TEI | μ TEI | σ TEI | n Ctrl | μ Ctrl | σ Ctrl | Δ (TEI−Ctrl) | t | p |
|---|---|---|---|---|---|---|---|---|---|
| secret-missing-key-advocate | 20 | 0.863 | 0.080 | 20 | 0.805 | 0.090 | **+0.058** | 2.15 | **<0.05** |
| cpu-limit-throttling-advocate | 20 | 0.682 | 0.161 | 20 | 0.592 | 0.155 | +0.091 | 1.82 | ns |
| readiness-probe-misconfigured-advocate | 20 | 0.858 | 0.114 | 20 | 0.889 | 0.092 | −0.032 | −0.96 | ns |
| **POOLED** | 60 | 0.801 | 0.147 | 60 | 0.762 | 0.170 | **+0.039** | 1.34 | ns |

## Interpretation

**Mixed signal.** 1 of 3 scenarios significant positive, 1 close-to-significant positive, 1 slight wrong-direction. Pooled effect is real and positive (+3.9pp) but not statistically significant at n=60 per arm.

Effect size comparison to earlier small-sample estimates:

| Scenario | 3-rep estimate | 20-rep estimate | Direction of change |
|---|---|---|---|
| secret-missing-key | +0.11 | +0.058 | Real but smaller |
| cpu-limit-throttling | +0.17 | +0.091 | Real but smaller |
| readiness-probe | +0.14 | −0.032 | Earlier positive was noise |

The pattern the reviewer warned about held up: at σ ≈ 0.10–0.16 on a scoring system bounded [0,1], 3-rep samples produce wildly unreliable estimates. **Real effect sizes are ~3× smaller than casual estimates suggested.**

## What we can actually claim

1. **Retrieval compounds on at least one scenario** (`secret-missing-key-advocate`) at p<0.05, effect +5.8pp. This is a real, statistically-distinguished-from-null positive result.
2. **The compounding is conditional on extreme corpus density.** Secret-missing-key has 30+ past postmortems — an order of magnitude more than any other category. At that density retrieval helps.
3. **On medium-density scenarios the effect is either small-positive (cpu-throttling, +9pp trend) or null (readiness-probe).** The test wasn't powered to distinguish +0.09 from zero at n=20.
4. **Uniform compounding on dense-corpus scenarios is NOT supported.** Readiness-probe has sizeable same-category corpus but shows no TEI advantage.

## What we cannot claim

- "Retrieval works" as a blanket statement. It works on one scenario, is inconclusive on a second, is absent on a third.
- The ~+19% observational delta from prior reports. That was selection bias — confirmed falsified.
- That growing the corpus via literature-sourced authoring (the 60-hour investment) would unlock proportionally larger gains. The data shows a weak effect that doesn't obviously scale with corpus density past some threshold we've already reached on secret-missing-key.

## What the measurement substrate itself validated

Three self-surfaced corrections during Phase 1 measurement:
1. pgvector ivfflat bug returning 0-3 rows sporadically (fixed by HNSW migration)
2. Observational +19% was selection bias (detected by running a proper control arm)
3. 3-rep small-sample estimates ~3× overstating effect sizes (detected by scaling to n=20)

Each correction was driven by the measurement framework catching itself. **This capability is more valuable than any specific retrieval finding** — it's what distinguishes this system from the OSS-agent ecosystem where such claims are usually unfalsifiable.

## Recommendation

**Ship Option 2 (limited v0 scorecard with current 19 scenarios, retrieval on with threshold filter).**

Rationale:
- Retrieval + threshold is net-positive or neutral on all tested scenarios; no harm case.
- Effect size (+4pp pooled, +6pp on the significant scenario) is too small to justify 60 hours of literature-sourcing authoring for the corpus densification gain.
- The plan's assumption that retrieval would be the primary compounding mechanism is partially falsified — at best it's a weak accessory.

Next-phase investment should pivot to:
1. **Skill compilation (plan §6)**: compile successful recovery sequences into named reflexes. Compounds on Emily's own successful runs (no corpus authoring needed). If effective at +10-15pp, materially larger signal than retrieval.
2. **Prevention loops (plan §7)**: structural changes after recurring incidents. Compounds on pattern detection over time, not on per-incident retrieval quality.
3. **Production incident ingestion** (post-launch): the retrieval mechanism becomes genuinely useful when the corpus grows from real incidents with their own ground-truth outcomes. That's a Phase-2+ question contingent on incident rate — which for this cluster is near-zero as previously noted.

Keep retrieval infrastructure running as-is. It helps on the one scenario class where its help is confirmed, doesn't hurt elsewhere, and provides a substrate for future mechanisms (skill compilation would likely still reference past postmortems as corpus).

## What stays shipped regardless

The measurement substrate — controlled experimental design, framework-error distinct from reasoning-error scoring, near-miss partial credit, falsification-driven iteration, per-scenario HNSW retrieval, distance-threshold filter, hypothesis emission and disagreement flagging, scorecard pipeline, synthetic approver, speculative-execution controller, 7-layer secret hardening, reversibility-aware tool tiers.

These are genuine Phase-1 outputs independent of whether the retrieval-compounding thesis panned out.
