# Architecture overview

`breakage/` is a measurement and learning substrate for Kubernetes operations agents. It deliberately breaks a target Kubernetes cluster, observes how an autonomous agent responds, scores the agent's behavior against ground truth, and accumulates structured records of every (context, action, outcome) tuple. Those records become input to retrieval-augmented inference on the agent's next incident — the *compounding* mechanism the framework is designed to measure.

This document describes what the framework is and how its pieces fit together. Reproduction instructions are in [getting-started.md](getting-started.md). Scenario authoring is in [authoring-scenarios.md](authoring-scenarios.md). Scorecard interpretation is in [interpreting-scorecards.md](interpreting-scorecards.md).

## What the framework does

The framework runs a *scenario*: a YAML file describing one specific cluster fault, the conditions for considering it fixed, the conditions for considering an out-of-scope regression, and the ground-truth root cause from a controlled vocabulary.

Running a scenario is a closed loop:

```
 scenario YAML
    │
    ├── injector mutates cluster state ──────┐
    │                                         ▼
    │                                    Emily (the agent)
    │                                         │
    │                                         ├─ retrieves similar past postmortems (k-NN over pgvector)
    │                                         ├─ executes Tier-1/2/3 tools against the cluster
    │                                         └─ writes a structured postmortem at resolution
    │
    ├── detector observes cluster state ─────┐
    │   • fixed_when conditions               │
    │   • regressed_when conditions           │
    │                                         ▼
    └── scorer combines observations ──── partial-credit score
                                              │     • detected (0.2)
                                              │     • diagnosed (0.3)
                                              │     • fixed (0.3)
                                              │     • no_regressions (0.2)
                                              ▼
                                         postmortem persisted
                                         to experience base
                                         with outcome label
```

The agent's tools are wrapped by a *speculative-execution controller* that snapshots cluster state before any Tier-2 mutation, watches for SLO regression in the seconds following, and auto-reverts on regression. The agent doesn't explicitly speculate — the controller observes, reverts, and produces a mechanical revert reason that the agent reads on its next inference cycle.

Retrieval over past postmortems happens *before* the agent's first tool call. Top-k similar postmortems (with their outcome labels — `resolved`, `regressed`, `inconclusive`) are injected into the agent's context as exemplars. This is the only mechanism through which past experience influences current behavior.

## Components

### Runner (`src/runner/`)

A Fastify HTTP server that orchestrates scenario execution. Endpoints:

- `POST /run { scenarioId }` — execute one scenario; returns a `ScorecardRun` summary.
- `GET /scenarios` — list loaded scenarios.
- `POST /retrieve { text, k, sources, maxDistance, poolCap }` — k-NN retrieval against the experience base. Used by the agent during incidents and by the harness during scoring.
- `POST /capture-postmortem` — agent posts here at incident resolution. Runner associates the postmortem with the active scenario.
- `POST /capture-hypothesis` — agent posts mid-investigation hypotheses. Runner accumulates them per-active-scenario for trajectory scoring.
- `GET /health` — liveness + active-scenario state.

Single-active-scenario model. Phase-1 design — multi-concurrent execution would require multi-tenancy in the active-scenario registry. See [authoring-scenarios.md](authoring-scenarios.md) for the schema validation rules the loader applies.

### Injectors (`src/injector/`)

Each injector is a small module implementing an `Injector` interface: given a scenario YAML's `injector` block, produce an `Undo` thunk that the orchestrator runs at scenario end. Implementations:

| Type | What it does |
|---|---|
| `deployment-patch` | Apply a JSON-Pointer-style mutation to a Deployment's spec (used by anchor scenarios) |
| `secret-content` | Mutate Secret data (e.g., remove a key, replace a value with junk) |
| `configmap-patch` | Mutate ConfigMap data |
| `flagd-flag` | Toggle a feature flag in a flagd-backed app (OTel Demo) |
| `network-policy` | Apply a NetworkPolicy that blocks specific traffic |
| `pod-evict` | Evict pods to simulate node-level disruption |

Adding a new injector: see [authoring-scenarios.md § Injector type catalog](authoring-scenarios.md#injector-type-catalog).

### Detectors (`src/detector/`)

The detector evaluates `fixed_when` and `regressed_when` expressions per scenario. Expressions are dispatched across handlers:

- `K8sExpressionHandler` — Kubernetes API conditions like `deployment.<ns>.<name>.readyReplicas == desiredReplicas`.
- `PromExpressionHandler` — Prometheus queries like `error_rate{ns=advocate} < 0.01`.

Handlers return `true | false | null`. Null means "not applicable" (e.g., Prometheus unreachable in k3d). Conditions can opt into `skip_if_unevaluable: true` to treat null as pass.

Sustained-for: each condition has an optional `sustained_for_s` window. The condition must hold continuously for that long to pass.

### Scorer (`src/scorer/`)

Pure-logic module. Inputs: scenario, observation (detected/fixed/regressions), postmortem, retrieved candidates, hypotheses. Outputs: `ScoreResult` with four-axis breakdown plus `retrieval_used` (observed via action-pattern matching) and `channel_disagreement` (last hypothesis vs final postmortem).

Key design decisions documented in [interpreting-scorecards.md](interpreting-scorecards.md):
- **Near-miss credit**: 0.35× diagnosis credit when the agent's category is in ground_truth's secondaries (or vice versa). Prevents undercounting on effect-vs-cause vocabulary overlap.
- **Containment matcher** (not Jaccard) for `retrieval_used`. Asymmetric — "did the agent's actions contain the retrieved postmortem's pattern?" — so longer investigations don't get penalized.

### Experience base (`experience-base/` + `src/experience-base/`)

PostgreSQL + pgvector schema. One table, `postmortems`, indexed on `embedding vector_cosine_ops` via HNSW (`m=16, ef_construction=64`) since the original `ivfflat` index returned 0–3 rows sporadically at small corpus sizes.

Migrations: `001_pgvector_and_postmortems.sql` (initial schema), `002_run_metadata.sql` (run-tagged metadata for scoring), `003_bge_m3_1024_dim.sql` (column dim for bge-m3), `004_hnsw_index.sql` (the index fix).

Embedder: `OpenAICompatibleEmbedder` defaults to the in-cluster `text-embeddings-inference` (TEI) pod serving `BAAI/bge-m3` (1024-dim, multilingual, 8192-token context). `BREAKAGE_EMBEDDER=deterministic` swaps in a DJB2-hash embedder used as the *control arm* in falsification experiments — it returns reproducible-but-semantically-random vectors so the threshold filter rejects all results.

Retrieval (`src/experience-base/retrieval.ts`):
- HNSW k-NN with cosine distance.
- `maxDistance` filter (default `BREAKAGE_RETRIEVAL_MAX_DISTANCE=0.40`) — drops weak matches before they reach the agent's prompt.
- `poolCap` knob (default unset) — limits the candidate pool to top-N nearest before threshold + k. Used by the corpus-density sweep experiment to simulate sparser corpora.

### Speculative-execution controller (`src/speculative-exec/`)

Wraps Tier-2 tool invocations with state snapshot + SLO-watch + auto-revert. Single-resource scope in Phase 1 (Deployments, ConfigMaps, Secrets — multi-resource Helm operations stay Tier-3-gated). Hard limit of N=2 reverts on the same scenario; the third attempt pauses for human review.

The controller produces a *mechanical revert reason* — the metric-level observation that triggered revert — but doesn't reason semantically about why the metric moved. That's the agent's job on its next inference cycle.

### Synthetic approver (`src/synthetic-approver/`)

Standalone HTTP service simulating a Tier-3 human approver. Configurable delay (default 300–800ms) and deny rate (default 0). Emits the same audit-log entries a real human would. Tested separately in `denial-recovery` scenarios where the agent must try a different approach after a denial rather than retry identically.

### Vocabulary (`vocab/root-cause-categories.yaml`)

Controlled multi-label vocabulary. ~24 categories at medium granularity — specific enough to discriminate, general enough for human agreement. Each category has an `id`, `description`, `example_incidents`, and optional `example_symptoms`.

The vocabulary is rendered into the agent's system prompt at runtime so its `primary_category` picks are bounded. Out-of-vocab picks score zero on the diagnosis axis.

Special category: `framework-error` is reserved for runs where the framework itself failed (injector throw, detector crash) before the agent could meaningfully act. Filter these rows out when judging agent capability.

## Key scoring decisions

These are documented per-axis in [interpreting-scorecards.md](interpreting-scorecards.md), but the architectural rationale lives here:

**`retrieval_used` is observed, not self-reported.** The agent isn't asked which retrievals it used. The scorer compares the agent's actual action sequence to each retrieved postmortem's `actions_taken`, using asymmetric containment (does the agent's tool sequence cover the retrieved postmortem's tool set?). Self-attestation would be hallucination-prone.

**Outcome labels are not filtered at retrieval time.** Both `resolved` and `regressed` past postmortems are returned to the agent as exemplars, with their outcomes explicitly labeled. The agent's prompt frames them as positive (resolved) and negative (regressed) examples. Filtering out failures would lose counterexample signal.

**Scenario context tokens flow through the agent's normal event intake.** There is no separate "eval mode." The agent emits hypotheses and writes postmortems in production exactly the way it does during scenarios. The framework filters its own observations by `scenario_id`; the agent doesn't know it's being measured.

**Always-on instrumentation.** `emit_hypothesis` and `write_postmortem` are tools available to the agent always. In production, the same postmortems are what human ops teams read at 3am.

## Data flow at scenario time

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │ harness (scripts/scenario-run.sh)                                    │
 │   ┌─────────────┐                                                    │
 │   │ runner /run │──┐                                                 │
 │   └─────────────┘  │                                                 │
 │                    │     ┌──────────┐                                │
 │                    ├────▶│ injector │ mutates k3d-scenarios cluster  │
 │                    │     └──────────┘                                │
 │                    │                                                 │
 │                    │     ┌──────────┐                                │
 │                    ├────▶│ detector │ polls cluster + Prom           │
 │                    │     └──────────┘                                │
 │                    │                                                 │
 │   ┌─────────────┐  │     ┌──────────┐                                │
 │   │ drive-emily │──┼────▶│  Emily   │ runs in k3d-scenarios as pod   │
 │   └─────────────┘  │     │  (agent) │                                │
 │                    │     └──────────┘                                │
 │                    │          │                                      │
 │                    │          │ POST /retrieve                       │
 │                    │          │ POST /capture-hypothesis (n times)   │
 │                    │          │ POST /capture-postmortem             │
 │                    │          ▼                                      │
 │                    └─── orchestrator ───┐                            │
 │                                         ▼                            │
 │                                    scorer                            │
 │                                         │                            │
 │                                         ▼                            │
 │                                  upsertPostmortem()                  │
 │                                         │                            │
 │                                         ▼                            │
 │                                  experience base (pgvector)          │
 └──────────────────────────────────────────────────────────────────────┘
```

The agent runs as a Pod inside the k3d-scenarios cluster (separate from production k3s). Its retrieval calls go through the runner's `/retrieve` endpoint; postmortem captures go through `/capture-postmortem`. The harness's `drive-emily` script just sends a synthetic alert message into the agent's normal event-intake path, identical to how it would receive a watcher event in production.

## Platform requirements

To reproduce:

- A Kubernetes cluster the framework can break (typically k3d, can be any conformant k8s 1.28+).
- PostgreSQL 14+ with `pgvector` extension.
- An OpenAI-compatible embeddings endpoint serving a 1024-dim model (or a different model with a matching schema migration). The reference setup uses `text-embeddings-inference` (TEI) with `BAAI/bge-m3`.
- Anthropic API key (or another provider that the operator agent supports).
- Optional: Prometheus, for scenarios whose detector conditions reference metrics. Without Prometheus, scenarios with metric conditions either skip those conditions (`skip_if_unevaluable: true`) or score lower.

[getting-started.md](getting-started.md) walks through bootstrapping all of this.

## What is *not* in scope

The framework does not:

- **Train models.** It produces (state, action, outcome) tuples; downstream training is a separate concern.
- **Inject across multiple clusters.** Single-cluster fault model. Multi-cluster (network partitions, cross-region failover) require additional injector support.
- **Reproduce app-level bugs.** The injectors operate at the Kubernetes-API level (manifest mutations, NetworkPolicies). Application-level faults (e.g., race conditions in the agent's own code) need a different shape of fault injection — typically via a configurable fault-injection layer in the application itself, like the OTel Demo's `flagd` integration.
- **Replace human review of agent behavior.** The scorecard is a measurement instrument, not an authoritative quality verdict. Cases where the scorer disagrees with itself across channels (the `channel_disagreement` flag) are flagged for human review and become training data for the inference model.

## Reading order

If you want to run the framework: [getting-started.md](getting-started.md).

If you want to write new scenarios: [authoring-scenarios.md](authoring-scenarios.md).

If you want to interpret a scorecard you already have: [interpreting-scorecards.md](interpreting-scorecards.md).

If you want to understand why the system is shaped the way it is, the reports under `breakage/reports/` document the experimental decisions in chronological order. The most informative single document is `breakage/reports/falsification-test-2026-04-24.md`, which is the controlled measurement that established what the framework's compounding-mechanism actually does and doesn't do.
