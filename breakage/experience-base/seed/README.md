# Experience base seed — real incidents from Emily's history

These YAMLs are the Week-1 bootstrap for the experience base. They are structured extractions from [`AUTONOMY.md`](../../../AUTONOMY.md) chapters and [`README.md`](../../../README.md) chronological wins/losses, reshaped into the [postmortem schema](../../src/types/postmortem.ts).

Purpose: give retrieval real examples to return before scenario #1 runs. Emily's compounding doesn't start at synthetic scenario #1 — it starts from lived experience that already has known outcomes.

## Loading

On `npm run migrate` the embedder reads every YAML in this directory, computes an embedding over the symptom signature + diagnosis + affected workload, and upserts into the `postmortems` table with `source='incident-log'`. Scenario runs later append with `source='scenario'`.

## Outcome labels matter

Retrieval returns both `resolved` and `regressed` postmortems. Emily sees them as positive exemplars ("here's what worked") and counterexamples ("here's what someone tried and regressed"). Excluding failures would discard the highest-signal training data in the corpus.

The `advocate-cascade` and `superuser-rotation` incidents are negative exemplars. They're the two losses that motivated the 7-layer hardening. Retrieval surfacing them when a similar symptom appears is the compounding — Emily reads the postmortem's `what_did_not_work` field and avoids the same pattern.

## Incidents seeded (Week 1)

| Incident ID | Date | Chapter / Ref | Outcome |
|---|---|---|---|
| `advocate-null-storage-path-2026-04-15` | 2026-04-15 | AUTONOMY.md Ch 3 | resolved |
| `eventstore-race-2026-04-17` | 2026-04-17 | AUTONOMY.md Ch 4 | resolved |
| `advocate-cascade-2026-04-17` | 2026-04-17 | AUTONOMY.md Ch 5 | **regressed** |
| `superuser-rotation-2026-04-20` | 2026-04-20 | AUTONOMY.md Ch 6 | **regressed** |
| `walsender-false-positive-2026-04-20` | 2026-04-20 | Triage rule incident | resolved |
| `publisher-reviews-proxy-pool-2026-04-20` | 2026-04-20 | Phase 1 deploy | resolved |
| `embeddings-model-swap-2026-04-22` | 2026-04-22 | Embeddings service rollout | **regressed** |
| `cpu-throttling-engine-vcpu-half-2026-03-12` | 2026-03-12 | engine CPU limit too low | resolved |
| `cpu-throttling-publisher-reviews-rps-burst-2026-04-12` | 2026-04-12 | publisher-reviews CPU burst | resolved |
| `replica-scale-down-partial-hpa-misfire-2026-02-24` | 2026-02-24 | HPA misfire scale 3→1 | resolved |
| `replica-manual-scale-zero-by-mistake-2026-03-28` | 2026-03-28 | Operator typo scaled replicas=0 | resolved |

**Corpus-density seeding (2026-04-24):** the four postmortems above were authored after the controlled retrieval-delta measurement found retrieval actively harming Emily on cpu-limit-throttling-advocate (−0.27) and replicas-zero-advocate (−0.31). The harm was caused by same-category-but-wrong-mechanism hits (OOM for CPU queries, image-pull for replica queries). These four postmortems seed direct precedents for the weak scenarios so the top retrieval hits match the mechanism, not just the category.

## Adding more

When a new production incident happens post-launch, add a YAML here (or via the automated ingestion pipeline once it exists). The seed directory is the canonical source of truth for incidents that predate the framework; post-framework incidents come in through the scenario runner's postmortem path.
