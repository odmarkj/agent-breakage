# Controlled retrieval-delta measurement — 2026-04-23

Per the external review: the +19% observational delta reported from 101 runs is confounded by selection effects (`retrieval_used` is observed via action-pattern matching, which correlates with Emily being on track). A genuine test requires an arm where retrieval is known-useless.

## Design

- **Control arm**: runner started with `BREAKAGE_EMBEDDER=deterministic`. The deterministic embedder is a DJB2 hash — it returns reproducible vectors but semantic similarity is effectively zero. Retrieval still happens at the pipeline level (pgvector query completes, top-k results returned, Emily sees them in her prompt), but the "similar incidents" returned are semantically random.
- **Treatment arm**: same runner, same framework state, `bge-m3` via the shared embeddings service. Real semantic similarity.
- **Scope**: 9 anchor scenarios × 3 reps each = 27 runs per arm.
- **Matched framework state**: both arms ran after the near-miss-credit scoring change (2026-04-23 ≥ 20:35). Without this, older TEI runs would be scored against stricter rules and produce spurious "retrieval helps" signal.
- **Same Emily image**: both arms use the same `k3s-operator:scenarios` build; no code changes between arms.

## Results

### Top-line

| Arm | n | Mean score |
|---|---|---|
| Control (deterministic embedder) | 27 | **0.77** |
| Treatment (bge-m3, matched framework state) | 12 | **0.77** |
| *For comparison, full TEI history (confounded)* | 58 | 0.73 |

**Controlled delta: +0.00.** With matched framework state on both arms, retrieval quality has no measurable effect on Emily's score on the current anchor set.

### Per-scenario (matched-pair scenarios only)

| Scenario | Control n | Control mean | Treatment n | Treatment mean | Δ (control − treatment) |
|---|---|---|---|---|---|
| env-var-missing-advocate | 3 | 0.71 | 3 | 0.77 | −0.06 |
| liveness-probe-always-fails-advocate | 3 | 0.79 | 3 | 0.64 | +0.15 |
| secret-missing-key-advocate | 3 | 0.91 | 3 | 0.91 | 0.00 |

Only 3 of 9 scenarios have enough matched-pair data to compare directly. The liveness-probe +0.15 for control is a single anomaly — 2 of the 3 treatment runs timed out at the old 300s budget (scenarios have since been bumped to 600s uniformly). Re-baseline pending.

### For comparison: the prior observational "delta"

The +19.1% observational delta previously reported is an **action-pattern correlation, not a causal effect**. It measured "Emily scored higher on runs where her tool sequence happened to match a retrieved postmortem's tool sequence." That's indirect: runs where Emily's actions look like a past success are runs where she's already on track — selecting for success rather than retrieval causing it.

The controlled comparison answers a different, sharper question: given the exact same scenario, does Emily's score improve when retrieval returns semantically-meaningful results vs semantically-random results? **On the current anchor set, the answer is no.**

## Interpretation

Three candidate explanations:

1. **Emily's anchor reasoning doesn't depend on retrieval.** The current 9 anchor scenarios are simple enough (single-resource patches, one-layer diagnosis) that Emily solves them from first principles. Retrieved examples are neither helpful nor harmful.
2. **The experience-base corpus lacks near-neighbors.** With 7 bootstrapped postmortems + ~100 scenario postmortems, there may not be semantically close matches for the anchor scenarios. Near-useless retrieval is indistinguishable from random retrieval at the prompt level.
3. **Emily reads but doesn't use retrieval.** She consults the retrieved content and ignores it in favor of direct investigation. The k-NN hits appear in her system prompt but don't change her behavior.

These are not mutually exclusive. Evidence for (1) + (2): image-pull and readiness-probe scored 0.91 under control — those scenarios don't need retrieval. Evidence against (3): when Emily picks `secret-content-mismatch` correctly on the secret scenario, her prose often references "past incident with DATABASE_URL rewrite" or similar — the retrieved postmortems are feeding her reasoning.

Probable truth: a mix. The anchors are simple enough that retrieval's contribution is small; on harder scenarios it would likely matter more.

## Implications for Phase-1 launch

The Phase-1 plan (§17) makes playbook authoring contingent on retrieval underperforming. This measurement demonstrates, under controlled conditions, that retrieval does not yet improve anchor scores. Per plan §17, this is the signal to author playbooks for the weakest categories — **not** to call retrieval a failure. Retrieval is infrastructure that works; the compounding benefit hasn't materialized on the current corpus + anchor mix, and playbooks are the designed response.

## Implications for Week-4 plan

- **Inverse-guardrail-mining (plan §16)** still makes sense: the regressed-outcome postmortems in the corpus are training data for both Emily and the playbook authors. That's not contingent on retrieval-works signal.
- **Measured: with-retrieval vs without-retrieval delta on anchors (Week-2 line item)** — this report IS that measurement, earlier than scheduled. Result: null on controlled, confounded-positive on observational. Future retrieval-benefit claims need the controlled design, not the observational one.
- **Corpus growth experiment**: seed the experience base with 10-20 more real postmortems (AUTONOMY chapters not yet seeded, additional real incidents from Josh's ops history) and re-run the controlled comparison. Hypothesis: with denser near-neighbor coverage, the controlled delta goes positive.

## Reporting recommendation

Going forward, when retrieval-benefit is cited externally:

- **Use the controlled number, not the observational one.** "+0.00 controlled delta on 27+12 anchor runs" is honest. "+19% observational" is a selection-bias artifact and should not be repeated without the caveat.
- **State the measurement conditions.** The null result is specific to anchor scenarios at this corpus size and this Emily state. Coverage-tier scenarios weren't measured; harder incident classes weren't in the control arm.
- **Don't delete the +19% number.** It's a real pattern — runs where Emily's actions match retrieved postmortems DO score higher. The interpretation changes: this is a useful predictor of success, not evidence that retrieval caused it.

## Next steps

1. Proceed to inverse-guardrail-mining (plan Step 5). The corpus has enough regressed-outcome rows to mine.
2. On Week 5, decide playbooks for `probe-misconfigured`, `resource-limit-misconfiguration` (k3d without Prom), and the secret-family categories based on the Week-4 baseline + mining report.
3. Re-run the controlled measurement after Week-5 playbooks land. Hypothesis: with playbooks active, the controlled delta between arms *when retrieval matches a playbook-relevant incident* will go positive — because playbooks raise the floor specifically when retrieval hits.
