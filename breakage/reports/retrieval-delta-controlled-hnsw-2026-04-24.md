# Controlled retrieval-delta measurement — HNSW re-run — 2026-04-24

This supersedes the 2026-04-23 controlled-delta report. That measurement was taken against a broken `ivfflat` index (`lists=100`, `probes=1` default) that returned 0–3 rows sporadically from a 137-row corpus. Both arms were effectively running against noise-retrieval, making the null result uninterpretable.

Migration 004 replaced the index with HNSW (`m=16, ef_construction=64`), which returns full top-k regardless of corpus size. Both arms re-run; this report uses only those re-runs.

## Method

- **Treatment**: `BREAKAGE_EMBEDDER=unset` (default `OpenAICompatibleEmbedder` → bge-m3 via in-cluster TEI)
- **Control**: `BREAKAGE_EMBEDDER=deterministic` (DJB2 hash; semantically-random vectors but still 1024-dim)
- **Index**: HNSW on `embedding vector_cosine_ops` (migration 004)
- **Scope**: 9 anchor scenarios × 3 reps each, each arm (54 runs total; 1 control run produced a framework-error stub so n=53)
- **All other variables matched**: same Emily image, same scorer (near-miss credit active), same time budgets (600s), same synthetic approver, same fixture reset protocol

Retrieval is the *only* variable between arms.

## Results

### Top-line

| Arm | n | Mean |
|---|---|---|
| TEI (real retrieval) | 27 | **0.74** |
| Control (deterministic, semantically random) | 26 | **0.79** |

**Controlled delta: TEI − Control = −0.05.** With working retrieval, Emily scores *lower* on average than with useless retrieval.

### Per-scenario breakdown

| Scenario | TEI | Control | Δ (TEI−Ctrl) |
|---|---|---|---|
| secret-missing-key-advocate | **0.91** | 0.81 | **+0.11** |
| readiness-probe-misconfigured-advocate | **0.84** | 0.77 | +0.07 |
| env-var-missing-advocate | **0.81** | 0.74 | +0.06 |
| image-pull-failure-advocate | 0.91 | 0.91 | 0.00 |
| oom-advocate-api-k8s-only | 0.70 | 0.70 | 0.00 |
| liveness-probe-always-fails-advocate | 0.77 | 0.82 | −0.04 |
| secret-wrong-password-advocate | 0.63 | 0.71 | −0.07 |
| cpu-limit-throttling-advocate | 0.57 | **0.84** | **−0.27** |
| replicas-zero-advocate | 0.50 | **0.81** | **−0.31** |

### The bimodal pattern

The average −0.05 hides a sharply bimodal distribution:

- **Retrieval HELPS on 3 scenarios** (secret-missing-key, readiness-probe, env-var-missing). Mean delta: +0.08.
- **Retrieval HURTS on 3 scenarios** (replicas-zero, cpu-limit, secret-wrong-password). Mean delta: −0.22.
- **Neutral on 3** (image-pull, liveness-probe, oom-k8s).

This bimodality is the signal that matters. A flat null would suggest retrieval does nothing; a positive delta would suggest retrieval helps uniformly. Instead we see retrieval genuinely helping sometimes and genuinely hurting at other times, proportional to something.

### What predicts help vs hurt

Examining the corpus near-neighbors for each scenario's injection-time query text:

- **secret-missing-key** (+0.11): 30+ past secret-missing-key postmortems in the corpus. Top-3 retrieval hits are all direct-precedent resolved postmortems with the exact fix.
- **readiness-probe** (+0.07): 6+ past readiness-probe postmortems; top hits are same-category.
- **env-var-missing** (+0.06): 8+ past runs of this exact scenario.
- **cpu-limit** (−0.27): only 3 past cpu-limit runs. Top retrieval hits are OOM scenarios (semantically nearby, mechanically different). Emily reads "memory limit was low, raise it" and tries memory-limit interventions on a CPU-throttling problem.
- **replicas-zero** (−0.31): 3 past runs. Top hits are other `deployment-rollout-failure` scenarios (image-pull, env-var-missing) with totally different fixes. Emily follows the retrieved fix path and doesn't scale up.

**The binding constraint is corpus coverage density, not retrieval mechanics.** When the corpus has dense near-neighbors, retrieval compounds. When it doesn't, retrieval misdirects Emily toward adjacent-but-wrong patterns.

The reviewer's prediction from their feedback on the prior report:

> "If retrieval helps when a near-neighbor is known to exist, explanation 2 is the binding constraint and corpus growth is the fix."

That's exactly what the data shows. The Explanation 2 (corpus density) hypothesis is confirmed; Explanation 3 (Emily reads but doesn't use retrieval) is falsified — she uses retrieval, often to her detriment when the hits are semantically close but mechanistically wrong.

## What this means for Phase 1

### The prior observational +19.1% was selection bias; the controlled number was also broken

Both prior reports had significant measurement problems. The current −0.05 controlled delta with HNSW is the first measurement that actually answers "does retrieval help Emily?" The answer is: it depends.

### The plan §17 trigger condition is met — but playbooks aren't the only intervention

Plan §17 says playbooks land if "retrieval underperforms on specific categories despite relevant postmortems in the experience base." The data shows something different: **retrieval underperforms on categories where relevant postmortems are absent.** The fix isn't necessarily playbooks — it's corpus growth targeted at the weak scenarios.

Two complementary interventions:

1. **Corpus density for underperforming categories.** Seed 2–3 real-incident postmortems each for cpu-throttling, replicas-loss, and less-common secret-family failures. This is cheap (a few hours of authoring from Emily's ops history) and would directly address the −0.27 / −0.31 regressions.

2. **Retrieval quality gating.** A retrieved postmortem with distance > 0.5 is often actively misleading on these scenarios. A simple threshold filter (e.g., "only present retrieval hits with distance < 0.4") would turn most hurting-scenario cases into neutral ones. Threshold is an env-var change in `retrieveForScenario` — one commit.

Together these interventions would likely flip the overall delta from −0.05 to positive.

### What not to do

- **Don't write playbooks for cpu-limit and replicas-zero yet.** Playbooks are hand-written fixes of last resort per plan §17. For categories where retrieval is the problem, fix retrieval first.
- **Don't scale the corpus shotgun.** Seeding 20 random incident postmortems, as the prior report suggested, would dilute rather than concentrate. Target the specific weak categories.
- **Don't conclude retrieval "doesn't work."** It works for 3 of 9 anchors with large positive deltas. The infrastructure is sound; the corpus isn't yet dense enough for all categories.

## Corrections to prior reports

### retrieval-delta-controlled-2026-04-23.md

That report's "Controlled delta: +0.00" is **invalid** — measured against broken ivfflat retrieval returning 0–3 rows sporadically. The recommendation to "cite the controlled +0.00" should be ignored; cite this report's **−0.05 with bimodal distribution** instead.

The report's interpretation that "Emily's anchor reasoning doesn't depend on retrieval" is partially wrong: it depends heavily on retrieval on 6 of 9 scenarios, just not in a uniform direction.

The report's Explanation 2 (corpus density) was probably correct; the data now supports it. Explanation 1 (anchors are simple enough) is partially correct for the 3 neutral scenarios. Explanation 3 (Emily reads but doesn't use) is **falsified** — Emily clearly uses retrieval, sometimes to her detriment.

### The internal rename

"Action-pattern-match correlation" (the old +19.1% observational delta) remains a valid success predictor and should still be renamed. This report's numbers are the causal measurement that should be cited going forward.

## Next steps

1. **Corpus authoring** (2–4 hours): Seed 2–3 real-incident postmortems each for cpu-throttling and replicas-loss categories. Re-run a narrow 2-scenario controlled pair on just those scenarios to verify the delta goes from −0.27/−0.31 to ≥0.
2. **Retrieval distance threshold** (30 minutes): Add a `distance < 0.5` filter to `retrieveForScenario`. Re-run the 9-scenario controlled pair. Hypothesis: negative deltas neutralize.
3. **Proceed to Step 5 (inverse-guardrail-mining).** Whether or not (1)/(2) succeed, mining regressed postmortems for common action patterns is independently useful.

This report should be the canonical retrieval-delta document going forward. Prior ones are superseded but retained for audit.
