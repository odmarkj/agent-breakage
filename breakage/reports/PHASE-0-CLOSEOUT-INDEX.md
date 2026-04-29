# Phase 0 closeout index

External-reader entry point into the substantive findings, ordered for someone who has not been in the project's day-to-day. Citations from these reports anchor everything in the larger `~/Apps/ai-manages-ai/` plan.

## What Phase 0 was for

Phase 1 (closed under earlier planning docs) built the substrate. Phase 0 is the *closeout*: tightening the central finding to publication standard, freezing the measurement substrate at a versioned state, and producing the external-reader documentation that lets a serious researcher reproduce the work in an afternoon.

The Phase-0 plan is in `~/.claude/plans/with-regards-to-looking-greedy-wolf.md`.

## Reports in reading order

For an outside reader who wants the central result first:

1. **[falsification-test-2026-04-24.md](falsification-test-2026-04-24.md)** — the controlled n=20 measurement of retrieval-vs-deterministic on three dense-corpus scenarios. Pooled Δ=+0.039 (1 of 3 significant at p<0.05). Identified corpus density as the binding constraint. This is *the* finding that the rest of Phase 0 tightens.

2. **[corpus-density-sweep-2026-04-28.md](corpus-density-sweep-2026-04-28.md)** — the within-scenario density manipulation experiment. 3 scenarios × 3 density tiers (poolCap=5/15/full) × 2 arms × 20 reps = 360 runs at Sonnet 4.6. Result: per-scenario heterogeneity dominates per-density variance. `secret-missing-key` shows significant positive Δ at all density tiers; `cpu-throttling` shows consistent negative Δ; `liveness-probe` is noise-dominated. The strong binding-constraint hypothesis (density alone matters) is partially falsified — mechanistic alignment of near-neighbors matters more than count. Pooled effect monotonic but ns at n=60 per tier.

3. **[n40-rerun-2026-04-28.md](n40-rerun-2026-04-28.md)** — n=40-per-arm tightening of cpu-throttling and replicas-zero. Confirms the density sweep's per-scenario findings: cpu-throttling Δ=−0.031 at n=40 (the n=20 t=1.82 was noise; effect is small/zero); replicas-zero Δ=+0.003 at n=40 (both arms ceiling at 0.91 — too easy to discriminate). The n=3 corpus-seed-verify "+0.41 swing" was a small-sample artifact.

For someone who wants the design history:

4. **[anchor-fail-audit-2026-04-23.md](anchor-fail-audit-2026-04-23.md)** — classification of why specific anchor scenarios were sub-threshold in early baselines. Bucketed into reasoning-failure / vocabulary-ambiguity / ground-truth-miscoding. Established that most low scores were vocab effect-vs-cause overlap, not capability gaps.

5. **[retrieval-corpus-seed-verify-2026-04-24.md](retrieval-corpus-seed-verify-2026-04-24.md)** — the targeted-seeding experiment that closed gaps on cpu-throttling and replicas-zero by adding 4 hand-authored postmortems to each category's corpus density. Demonstrates that corpus density is a *fixable* binding constraint via literature-sourced authoring, not a structural ceiling.

6. **[pitfalls-mining-mvp-2026-04-24.md](pitfalls-mining-mvp-2026-04-24.md)** — the inverse-guardrail-mining pipeline (`npm run pitfalls`). Validated against synthetic baseline to surface known agent vocab-drift independently of human review.

7. **[emily-prod-scenarios-divergence-2026-04-23.md](emily-prod-scenarios-divergence-2026-04-23.md)** — audit of the divergence between production-deployed Emily and the scenarios-cluster Emily, plus the `sync-emily-context.sh` mechanism that prevents silent drift.

For predecessors that have been superseded but kept for audit:

8. [retrieval-delta-controlled-2026-04-23.md](retrieval-delta-controlled-2026-04-23.md) — superseded by the HNSW re-run after a pgvector ivfflat bug was found returning 0–3 rows sporadically.
9. [retrieval-delta-controlled-hnsw-2026-04-24.md](retrieval-delta-controlled-hnsw-2026-04-24.md) — interim version before n was scaled to 20 per arm.
10. [retrieval-threshold-arm-2026-04-24.md](retrieval-threshold-arm-2026-04-24.md) — examined whether a distance-threshold filter alone neutralized the harm seen on sparse-corpus scenarios. Result: partial; corpus seeding does the rest of the work.

## Documentation

External-reader documentation under [`docs/`](../docs/) and [`../../operator/docs/`](../../operator/docs/):

- [`docs/architecture.md`](../docs/architecture.md) — system overview
- [`docs/getting-started.md`](../docs/getting-started.md) — clone-to-reproduce path
- [`docs/authoring-scenarios.md`](../docs/authoring-scenarios.md) — how to write a scenario YAML
- [`docs/interpreting-scorecards.md`](../docs/interpreting-scorecards.md) — what scorecard output means
- [`../../operator/docs/seven-layer-hardening.md`](../../operator/docs/seven-layer-hardening.md)
- [`../../operator/docs/tier-based-approval.md`](../../operator/docs/tier-based-approval.md)
- [`../../operator/docs/speculative-execution.md`](../../operator/docs/speculative-execution.md)
- [`../../operator/docs/reversibility-classification.md`](../../operator/docs/reversibility-classification.md)

## What's frozen

After Phase 0 closeout the framework is at a versioned-release state. Specifically:

- Migration 004 (HNSW index) is the latest schema. Pre-004 corpora produce undefined results.
- `BREAKAGE_RETRIEVAL_MAX_DISTANCE=0.40` is the published default threshold. Override only with an explicit reason.
- `BREAKAGE_RETRIEVAL_POOL_CAP` is the new (Phase-0) knob for corpus-density experiments. Default unset.
- The vocabulary at `breakage/vocab/root-cause-categories.yaml` has 24 categories. Future Phase-2+ work expanding the vocab should preserve all 24 IDs (deprecation rather than removal).
- Anchor scenarios at `breakage/scenarios/anchor/`: 9 active + 1 regression-watch. Coverage scenarios across 3 tranches.

The next phase (the larger plan's Phase 1: public release of the open-source framework + falsification paper to arXiv + strategic essay) consumes these artifacts as inputs.

## Citations

When citing this work externally, the canonical references are:

- **Substrate**: `breakage/` directory at the version tag this report is committed under.
- **Headline finding**: `falsification-test-2026-04-24.md` for n=20; `corpus-density-sweep-*.md` for the publication-quality version.
- **Methodology**: `docs/architecture.md` plus `docs/interpreting-scorecards.md`.
- **Reproduction guide**: `docs/getting-started.md`.
- **Agent architecture context**: `operator/docs/`.
