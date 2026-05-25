# agent-breakage

A measurement and learning substrate for autonomous Kubernetes operations agents.

`https://github.com/odmarkj/agent-breakage`

This repository contains two sibling projects:

- **`breakage/`** — a closed-loop measurement framework. Deliberately injects faults into a Kubernetes cluster, observes how an agent responds, scores the response on four axes against ground truth, and accumulates structured (state, action, outcome) tuples for retrieval-augmented inference on the next incident.
- **`operator/`** — Emily, the autonomous Kubernetes operator the framework was built around. Tier-based action authority, seven-layer hardening of the autonomy surface, speculative-execution controller, reversibility-aware tool tiers.

Both ship together because the falsification reproducer (described below) requires the agent to be in the loop. Either component can be replaced — the framework's hypothesis-testing scaffolding is agent-agnostic — but for a working hello-world, both are needed.

## Why this exists

The falsification finding it was built to test:

> Does retrieval over past postmortems compound an agent's capability over time?

The published answer ([`breakage/reports/falsification-test-2026-04-24.md`](breakage/reports/falsification-test-2026-04-24.md), n=20 controlled): mixed-positive on the densest-corpus scenario, null elsewhere. Pooled effect +3.9pp, not significant. The strong compounding hypothesis doesn't survive at the scale a single cluster can produce.

The within-scenario corpus-density sweep that followed ([`breakage/reports/corpus-density-sweep-2026-04-28.md`](breakage/reports/corpus-density-sweep-2026-04-28.md), 360 runs) and the n=40 reruns ([`breakage/reports/n40-rerun-2026-04-28.md`](breakage/reports/n40-rerun-2026-04-28.md), 160 runs) tighten the finding to publication standard.

The substrate is the durable contribution. The retrieval result is one worked example.

## Reproducing the falsification

Start with [`breakage/docs/getting-started.md`](breakage/docs/getting-started.md) — clone-to-reproduce in roughly 90 minutes from a clean machine.

Then:

```bash
SCENARIOS="secret-missing-key-advocate cpu-limit-throttling-advocate readiness-probe-misconfigured-advocate" \
REPS=20 \
  bash breakage/scripts/falsify-tei.sh

SCENARIOS="..." REPS=20 \
  bash breakage/scripts/falsify-control.sh
```

Wall clock: ~5 hours per arm. ~$30-60 in API credits per arm at default model.

Expected: numbers within ±5pp of [`breakage/reports/falsification-test-2026-04-24.md`](breakage/reports/falsification-test-2026-04-24.md).

If your numbers fall outside that band, the most likely causes are:
- Embeddings endpoint compatibility (we used TEI serving `BAAI/bge-m3` at 1024-dim; OpenAI `text-embedding-3-small` requires migration adjustment)
- pgvector version (≥0.5.0; HNSW is required as of migration 004)
- k3d/k3s version drift in the scenario injectors

Open an issue with the diff and the env detail; reproducibility is the bar.

## Documentation

External-reader documentation, in reading order for someone who has not been in the project:

- [`breakage/docs/architecture.md`](breakage/docs/architecture.md) — system overview
- [`breakage/docs/getting-started.md`](breakage/docs/getting-started.md) — clone-to-reproduce
- [`breakage/docs/authoring-scenarios.md`](breakage/docs/authoring-scenarios.md) — scenario YAML schema, injector and detector languages
- [`breakage/docs/interpreting-scorecards.md`](breakage/docs/interpreting-scorecards.md) — what the four-axis scoring measures

For the agent (Emily):

- [`operator/docs/seven-layer-hardening.md`](operator/docs/seven-layer-hardening.md)
- [`operator/docs/tier-based-approval.md`](operator/docs/tier-based-approval.md)
- [`operator/docs/speculative-execution.md`](operator/docs/speculative-execution.md)
- [`operator/docs/reversibility-classification.md`](operator/docs/reversibility-classification.md)

For the substantive findings, ordered for an outside reader:

- [`breakage/reports/PHASE-0-CLOSEOUT-INDEX.md`](breakage/reports/PHASE-0-CLOSEOUT-INDEX.md) — the closeout index. Start here.

## What this is and isn't

This is a measurement and learning substrate. It produces (state, action, outcome) tuples; downstream model training is out of scope of this release. Single-cluster fault model; multi-cluster failure modes need additional injector support. App-level faults need a fault-injection layer in the application (the OTel Demo tranche is the model).

The substrate is reproducible. The published falsification result is reproducible. Anything cited from this repository should be reproducible by anyone with the prerequisites listed in [`breakage/docs/getting-started.md`](breakage/docs/getting-started.md). That's the bar.

## Status

This is an initial public release at tag `v0.1.0` (squash-init from internal tag `phase-0-frozen-2026-04-28`). The substrate is at a versioned-release state:

- Migration 004 (HNSW index) is the latest schema; pre-004 corpora produce undefined results.
- `BREAKAGE_RETRIEVAL_MAX_DISTANCE=0.40` is the published default threshold.
- The vocabulary at `breakage/vocab/root-cause-categories.yaml` has 24 categories; future expansion preserves all 24 IDs.
- 9 active anchor scenarios + 1 regression-watch; coverage scenarios across 3 tranches.

The methodology paper ([arXiv:2605.23058](https://arxiv.org/abs/2605.23058), Phase 1 Artifact 2 of the larger plan) cites this repository at tag `v0.1.0` for the reported numbers.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Briefly:
- New scenarios are welcome — follow [`breakage/docs/authoring-scenarios.md`](breakage/docs/authoring-scenarios.md).
- Bug reports for the framework are welcome.
- Agent rewrites (replacing Emily) are out of scope of this repo; fork or open a discussion if you want to swap the agent under test.

## License

Apache 2.0. See [`LICENSE`](LICENSE).

## Citation

If you reference this work in academic or engineering publications, cite the arXiv paper:

```
Odmark, J., Rubin, G., & van der Vyver, D. (2026). A measurement substrate for
agentic Kubernetes operations: methodology and a case study in
retrieval-compounding falsification. arXiv:2605.23058.
https://arxiv.org/abs/2605.23058
```

---

*Author: Joshua Odmark · joshua.odmark@gmail.com · Independent*
