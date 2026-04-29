# breakage/ — closed-learning-loop measurement substrate

`breakage/` is a measurement and learning substrate for Kubernetes operations agents. It deliberately breaks a target Kubernetes cluster, observes how an autonomous agent responds, scores the agent's behavior against ground truth, and accumulates structured records of every (context, action, outcome) tuple. Those records feed retrieval-augmented inference on the agent's next incident.

The system was built to answer a specific empirical question: *does retrieval over past postmortems compound an agent's capability over time?* The published answer (mixed-positive on dense corpora, null on sparse) is documented in [`reports/falsification-test-2026-04-24.md`](reports/falsification-test-2026-04-24.md) and the corpus-density sweep that followed.

## Documentation

For external readers, four documents under [`docs/`](docs/):

- **[Architecture overview](docs/architecture.md)** — system components, data flow, what's in scope and what's not
- **[Getting started](docs/getting-started.md)** — clone-to-reproduce-falsification path
- **[Authoring scenarios](docs/authoring-scenarios.md)** — schema, injector type catalog, detector expression language, worked example
- **[Interpreting scorecards](docs/interpreting-scorecards.md)** — what the four-axis scoring measures, common gotchas, programmatic access patterns

For the operator agent ("Emily") that runs against this framework, see [`operator/docs/`](../operator/docs/).

## The closed loop, briefly

```
 scenario → injector breaks something → agent acts live (wrapped by
 speculative-exec controller) → detector observes cluster state → scorer
 computes partial credit → agent writes structured postmortem → postmortem
 embedded + stored → retrieval augments the next incident's inference
```

Retrieval over past postmortems happens *pre-action* on every incident — scenario or production. The compounding hypothesis is that agent quality improves as the corpus grows. The hypothesis is partially falsified — see the falsification report.

## Directory layout

```
breakage/
  docs/                              # external-reader documentation (start here)
  src/
    runner/                          # Fastify HTTP server orchestrating scenario execution
    types/                           # shared TypeScript types (Scenario, Postmortem, ScoreResult)
    injector/                        # injector implementations per type
    detector/                        # K8s + Prometheus expression handlers
    scorer/                          # four-axis partial-credit scorer
    experience-base/                 # pgvector schema, embedder, retrieval
    reports/                         # pitfall mining
  experience-base/
    migrations/                      # SQL (pgvector + postmortems table + HNSW)
    seed/                            # bootstrap postmortems (real incidents)
  speculative-exec/                  # state snapshot + SLO-watch + auto-revert
  scenarios/
    anchor/                          # deep-validated scenarios with 5-rep baselines
    coverage/<tranche>/              # tranche-organized coverage scenarios
  vocab/
    root-cause-categories.yaml       # ~24 medium-granularity categories
  synthetic-approver/                # Tier-3 approval simulator
  schemas/                           # JSON Schema for YAML validation
  scripts/                           # run harnesses
  reports/                           # scorecard + experimental reports
    pitfalls/                        # inverse-guardrail-mining outputs
  fixtures/                          # the prod-advocate test workload
  deploy/                            # operator (agent) deployment manifests for k3d
```

## Quick reference

| Command | What it does |
|---|---|
| `npm run migrate` | Apply experience-base migrations (`001` schema, `002` run_metadata, `003` bge-m3 1024-dim, `004` HNSW index) |
| `npm run seed` | Load bootstrap postmortems from `experience-base/seed/*.yaml` |
| `npm run dev` | Start scenario runner on :8088 |
| `npm run scorecard` | Generate `reports/scorecard-<timestamp>.md` from current postmortems table |
| `npm run pitfalls` | Run inverse-guardrail-mining; write per-category reports under `reports/pitfalls/` |
| `./scripts/scenario-run.sh <id>` | Run one scenario end-to-end |
| `./scripts/density-sweep.sh` | Run the corpus-density sweep experiment |

## Running the falsification reproducer

After [getting-started](docs/getting-started.md):

```bash
SCENARIOS="secret-missing-key-advocate cpu-limit-throttling-advocate readiness-probe-misconfigured-advocate" \
REPS=20 \
  bash breakage/scripts/falsify-tei.sh

SCENARIOS="..." REPS=20 \
  bash breakage/scripts/falsify-control.sh

# Then analysis per docs/interpreting-scorecards.md
```

Wall-clock ~5 hours per arm. ~$30-60 in API credits per arm at default model.

## Reports of record

The substantive findings, in order they were produced:

- `reports/falsification-test-2026-04-24.md` — controlled retrieval vs deterministic, n=20 per arm. The headline result.
- `reports/retrieval-corpus-seed-verify-2026-04-24.md` — corpus-seeding closes the gap on previously-failing scenarios.
- `reports/anchor-fail-audit-2026-04-23.md` — classification of why specific anchors were sub-threshold (vocab vs reasoning vs ground-truth-miscoding).
- `reports/pitfalls-mining-mvp-2026-04-24.md` — inverse-guardrail-mining pipeline validated against synthetic baseline.
- (Phase 0) `reports/corpus-density-sweep-*.md` — within-scenario density manipulation experiment.

## What scope this is and isn't

This is a measurement and learning *substrate*, not a complete agent. It produces (state, action, outcome) tuples; downstream model training is out of scope. Single-cluster fault model; multi-cluster failure modes need additional injector support. App-level faults need a fault-injection layer in the application (the OTel Demo tranche is the model).

The substrate is reproducible. The published falsification result is reproducible. Anything cited from this directory should be reproducible by anyone with the prerequisites listed in `docs/getting-started.md`. That's the bar.
