# Authoring scenarios

A scenario is a YAML file under `breakage/scenarios/` that fully describes one cluster fault: what to break, how to know when it's fixed, what counts as a regression, and what the ground-truth root cause is. The framework's loader validates every scenario against `breakage/schemas/scenario.json` and rejects vocab IDs that don't appear in `vocab/root-cause-categories.yaml`.

This document covers:

1. The full schema, field by field.
2. The injector type catalog.
3. The detector expression language.
4. How to pick a `ground_truth.primary_category` from the controlled vocabulary.
5. A worked example transcribing a real public incident into a scenario.

## File layout

```
breakage/scenarios/
  anchor/                            # ~15 deep-validated scenarios with 5-rep baselines
  coverage/
    sre-book-ch22-cascading/         # Google SRE Book ch. 22 patterns
    k8s-troubleshooting/             # community Kubernetes troubleshooting docs
    otel-demo-flagd-faults/          # OTel Demo flagd-toggle scenarios (multi-service)
    <new-tranche>/                   # add new tranches here
      README.md                      # source attribution + scope
      COVERAGE.md                    # which patterns from the source are covered
      *.yaml                         # scenarios
```

Anchor scenarios are *deep* (5-rep baselines, full partial-credit scoring, noise-floor validated). Coverage scenarios are *broad* (3-rep baselines, pass/fail-leaning scoring). Coverage scenarios get promoted to anchor tier as their patterns stabilize.

## Schema

```yaml
# Identifier — must match filename, kebab-case. Globally unique.
id: oom-advocate-api-k8s-only

# Where in the system the fault lives. Used for filtering and reporting.
plane: infra | config | app

# Free-form symptom class. Used in retrieval embeddings; pick a phrase
# that a postmortem author would write.
symptom_class: resource-exhaustion

# Provenance. Either "synthetic:<id>" for a made-up scenario or
# "<incident-id>" for a real-world reproduction. The latter is
# strongly preferred — anchor scenarios should map to documented
# real-world incidents.
origin: synthetic:canonical-phase-1-anchor-plan-example

difficulty: easy | medium | hard

tier: anchor | coverage | retired

status: active | regression-watch | stable | retired
# regression-watch — scenario depends on infra (e.g., Prometheus) that
# may not be present in every reproduction environment. Excluded from
# default baseline runs but kept in the library for on-demand testing.

source_tranche: null | sre-book-ch22-cascading | k8s-troubleshooting | ...
# Only meaningful for coverage scenarios.

injector:
  type: deployment-patch | secret-content | configmap-patch | flagd-flag | network-policy | pod-evict
  target:
    ns: prod-advocate
    deploy: advocate-api          # type-dependent fields below
  # Per-type fields (see Injector type catalog below)

detector:
  fixed_when:                     # ALL conditions must hold simultaneously
    - expression: deployment.prod-advocate.advocate-api.readyReplicas == desiredReplicas
      sustained_for_s: 60         # seconds the condition must hold continuously
    - expression: error_rate{ns=prod-advocate} < 0.01
      sustained_for_s: 120
      skip_if_unevaluable: true   # if Prom unreachable, treat as pass
  regressed_when:                 # ANY condition tripping = regression
    - expression: cluster_slo_delta > 0.05 in any out-of-scope namespace

scorer:
  time_budget_s: 600              # max wall-clock for the agent to act
  scope:
    - prod-advocate               # used for blast-radius detection
  credits:                        # axis weights, must sum to 1.0
    detected: 0.2
    diagnosed: 0.3
    fixed: 0.3
    no_regressions: 0.2

ground_truth:
  primary_category: resource-limit-misconfiguration
  secondary_categories:           # optional, used for compound-cause + near-miss credit
    - probe-misconfigured
```

## Injector type catalog

Each type accepts a different `target` + per-type field set.

### `deployment-patch`

Apply a JSON-Pointer-style mutation to a Deployment's spec.

```yaml
injector:
  type: deployment-patch
  target:
    ns: prod-advocate
    deploy: advocate-api
  mutation: spec.template.spec.containers[0].resources.limits.memory = "32Mi"
```

The mutation parser handles scalars (string, number, bool, null), empty array `[]`, and empty object `{}`. For more complex transformations (e.g., adding an env var), write a dedicated injector type rather than extending the parser.

### `secret-content`

Patch a Secret's data field. Used to remove keys, replace values with junk, etc.

```yaml
injector:
  type: secret-content
  target:
    ns: prod-advocate
    secret: advocate-secrets
  ops:
    - op: remove
      path: /data/SESSION_SECRET
```

Multiple ops apply in order. Patches use JSON Patch syntax via the K8s API.

### `configmap-patch`

Same as secret-content but for ConfigMaps.

### `flagd-flag`

Toggle a feature flag in a flagd-backed application. Used by the OTel Demo tranche.

```yaml
injector:
  type: flagd-flag
  target:
    ns: otel-demo
    configmap: flagd-config
  flag: paymentFailure
  variant: "on"
```

### `network-policy`

Apply a NetworkPolicy that blocks specific traffic.

```yaml
injector:
  type: network-policy
  target:
    ns: prod-advocate
  policy: |
    apiVersion: networking.k8s.io/v1
    kind: NetworkPolicy
    metadata:
      name: block-egress-to-postgres
    # ... full policy body
```

### `pod-evict`

Evict pods to simulate node-level disruption.

```yaml
injector:
  type: pod-evict
  target:
    ns: prod-advocate
    selector:
      app: advocate-api
  count: 1
```

### Adding a new injector type

A new type lives at `src/injector/<type>.ts` implementing the `Injector` interface:

```typescript
export interface Injector {
  type: string;
  inject(scenario: Scenario, definition: TypedInjector): Promise<Undo>;
}

export type Undo = () => Promise<void>;
```

Register the new type in `src/injector/registry.ts` and add a JSON Schema entry in `breakage/schemas/scenario.json`. The undo callback runs after scenario completion regardless of pass/fail and should be defensive (idempotent, safe on already-restored state).

## Detector expression language

Expressions are dispatched across registered handlers, in order. The first handler whose pattern matches wins.

### K8s expressions (always available)

```
deployment.<ns>.<name>.readyReplicas == desiredReplicas
deployment.<ns>.<name>.availableReplicas >= 3
pod.<ns>.<name>.phase == Running
pod.<ns>.<name>.containerRestartCount == 0
service.<ns>.<name>.endpoints > 0
```

The handler queries the K8s API and returns true/false. Returns `null` (unevaluable) only on transient API errors.

### Prometheus expressions (require PromExpressionHandler reachable)

```
error_rate{ns=advocate} < 0.01
http_request_duration_seconds{ns=advocate, quantile=0.99} < 1
cluster_slo_delta > 0.05 in any out-of-scope namespace
```

The handler issues a PromQL query against `BREAKAGE_PROMETHEUS_URL` (default unset). When unreachable, it returns `null`. Conditions can opt into `skip_if_unevaluable: true` to treat null as pass — used by anchor scenarios that have a Prom-dependent verifier as a *strengthening* check that can be skipped in environments without Prom.

### Custom handlers

A scenario tranche can register a custom handler in `src/detector/<tranche>-handler.ts`. See `OtelDemoExpressionHandler` for an example that queries the OTel Demo's frontend `/health` endpoint directly.

## Picking ground_truth.primary_category

Read `breakage/vocab/root-cause-categories.yaml` end-to-end before authoring. The vocabulary has ~24 medium-granularity categories. Multi-label is supported via `secondary_categories`.

Heuristic: write the scenario's diagnosis as you'd want a human SRE to read it. Identify the *most upstream* root cause. That's the primary. Effects of the root cause that an SRE might also tag are secondaries.

For example, a Deployment with a tight CPU limit that causes pods to throttle and miss readiness probes:

- **Most upstream cause**: the CPU limit value is wrong → `resource-limit-misconfiguration`.
- **Effect noticeable from K8s state**: probes fail → `probe-misconfigured` as secondary.
- **Effect at the Service level**: rollout never stabilizes → `deployment-rollout-failure` as secondary.

Choose the primary that an experienced SRE would name first. The framework's near-miss-credit mechanism awards 0.35× diagnosis credit when the agent picks a category that's in the scenario's secondaries, which avoids penalizing reasonable effect-vs-cause ambiguity.

If no existing category fits, do *not* invent one in the YAML — the loader will reject it. Either:

1. Add a new entry to `vocab/root-cause-categories.yaml` with a description and example incidents (preferred for any pattern you expect to see again).
2. Use `symptom-misdiagnosis` or another close-fit category and add the new pattern to `secondary_categories` for tracking; promote to a real category once you have ≥3 examples of it.

## Worked example: transcribing a CNCF incident

Suppose you want to add a scenario inspired by the public Stripe 2019 outage where a runaway sidecar container caused front-end timeouts. The CNCF-stories writeup gives you:

- Symptom: ingress-level timeouts on a specific service.
- Root cause: a sidecar's resource consumption starved the main container.
- Fix: raise the sidecar's CPU/memory limits OR remove the sidecar.

Draft scenario:

```yaml
id: sidecar-resource-starvation-advocate
plane: config
symptom_class: ingress-timeout-from-sidecar-pressure
origin: cncf-failures:stripe-2019-runaway-sidecar
difficulty: medium
tier: coverage
status: active
source_tranche: cncf-failures

injector:
  type: deployment-patch
  target:
    ns: prod-advocate
    deploy: advocate-api
  mutation: spec.template.spec.containers[1].resources.limits.cpu = "100m"
  # The fixture has a sidecar at index 1; we drop its CPU limit to
  # 100m so under any load it starves and the main container slows.

detector:
  fixed_when:
    - expression: deployment.prod-advocate.advocate-api.readyReplicas == desiredReplicas
      sustained_for_s: 30
    - expression: http_request_duration_seconds{ns=prod-advocate, quantile=0.95} < 0.5
      sustained_for_s: 60
      skip_if_unevaluable: true
  regressed_when: []

scorer:
  time_budget_s: 600
  scope:
    - prod-advocate
  credits:
    detected: 0.2
    diagnosed: 0.3
    fixed: 0.3
    no_regressions: 0.2

ground_truth:
  primary_category: resource-limit-misconfiguration
  secondary_categories:
    - sidecar-pressure-spillover
```

This scenario assumes the fixture has a sidecar at containers[1]. If your fixture doesn't, you'd modify the fixture (`breakage/fixtures/prod-advocate/`) to include one, or pick a different injector strategy. The sidecar-pressure-spillover category doesn't yet exist in the vocab — adding it would require a vocab-yaml edit with a description and at least one example incident.

## Validation

After writing a scenario, run:

```bash
npm run scenarios -- --validate path/to/scenario.yaml
```

This invokes the loader's full validation path (JSON Schema + vocab-id check) without running the scenario. Errors are pointed-to with JSON Pointer paths.

For scenario-tranche introduction, also run a 1-rep smoke test with the harness:

```bash
REPS=1 SCENARIOS="<your-scenario-id>" bash scripts/density-sweep.sh   # if testing density behavior
# or
./scripts/scenario-run.sh <your-scenario-id>                          # for plain validation
```

This ensures injector/detector wire correctly against the running fixture before a 3- or 5-rep baseline.

## Anchor vs coverage promotion

A coverage scenario gets promoted to anchor tier when:

1. It runs cleanly across ≥10 baselines without framework-error rows.
2. Its detector is stable — no flaky pass/fail at default time budget.
3. The injection has been validated to actually exercise the failure mode (e.g., via reading the agent's postmortems and confirming they accurately diagnose what the injector did).
4. There's an authored real-incident postmortem in `experience-base/seed/` that the scenario can retrieve against.

The promotion ritual is moving the YAML from `coverage/<tranche>/` to `anchor/`, raising `tier` to `anchor`, optionally renaming, then re-running with 5 reps. Scorecard entries pre-promotion stay tagged with the old tier in their `run_metadata`.
