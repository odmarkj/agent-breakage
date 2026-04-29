# Speculative-execution controller

The agent's autonomous-repair authority is bounded by an envelope: every Tier-2 mutation is wrapped in *snapshot before, watch SLOs after, auto-revert on regression*. The agent doesn't explicitly speculate. The controller observes, watches, and reverts without agent cooperation.

This document explains the controller's design, why each piece exists, and where it lives in the codebase.

The high-level claim it enables: *"the agent fixes live and records after."* Without the controller, that claim requires trusting the agent's judgment on every action. With the controller, it requires trusting the snapshot+watch+revert mechanism — a much smaller surface that you can test directly.

## The problem the controller solves

Code agents work because their actions can be staged and reviewed (a PR, a test suite, a CI run) before they hit production. Operations agents lose that staging because the artifact is the cluster itself: there's no separate place to dry-run a `kubectl scale` before applying it. The agent's authority and its blast radius are coupled in a way they aren't for code.

The controller breaks that coupling. The agent acts directly on the live cluster, but the controller maintains a parallel state: pre-action snapshot, time-bounded post-action SLO observation, automatic reversion if SLO regresses. The agent gets autonomous-execution speed; the cluster gets bounded blast radius.

## The four pieces

The controller has four sub-services. They live in [`breakage/src/speculative-exec/`](../../breakage/src/speculative-exec/):

### 1. State snapshot

Before every Tier-2 mutation, capture the current state of *the resource being mutated plus its associated dependencies*. For a Deployment patch:

- The Deployment manifest itself.
- Any ConfigMaps the Deployment references via `envFrom` or volume mount.
- Any Secrets the Deployment references.
- The PodDisruptionBudget for the Deployment, if any.
- The HorizontalPodAutoscaler, if any.

Stored as a typed snapshot keyed by `(scenario_id_or_incident_id, action_id, timestamp)`. Implementation in [`breakage/src/speculative-exec/snapshot/`](../../breakage/src/speculative-exec/snapshot/).

The snapshot scope is *single-resource-plus-dependencies*. Multi-resource operations (Helm releases, operator-reconciled custom resources) have multiple-controller race conditions that single-resource snapshots can't safely revert. Those operations stay Tier-3-gated in Phase 1.

### 2. SLO-watch timer

After the mutation lands, the controller starts a configurable timer (default 15-60s depending on action class). During that window it polls metrics:

- `error_rate` for the affected namespace
- `p95_latency` for the affected service's HTTP path (if available)
- `pod.readyReplicas` for the affected workload
- Cluster-level: `cluster_slo_delta` for any *out-of-scope* namespace (regression in unrelated services indicates blast radius spillover)

Implementation in [`breakage/src/speculative-exec/watcher/`](../../breakage/src/speculative-exec/watcher/).

The watch window is bounded — typically tens of seconds to a couple of minutes. If SLOs are still degrading at window end, that's a regression and the controller fires.

### 3. Auto-revert on regression

If a watched SLO crosses its regression threshold during the watch window, the controller restores the snapshotted state via a single API call (server-side apply for resources, regular update for stateful types). The agent's running goal pauses for one event-loop tick — long enough to see the revert reason — and then continues.

Implementation in [`breakage/src/speculative-exec/revert/`](../../breakage/src/speculative-exec/revert/).

### 4. Mechanical revert reason

The controller produces a structured *mechanical revert reason* — the exact metric-level observation that triggered the revert. Example:

```
revert_reason: {
  trigger: "error_rate_threshold",
  before_action: { error_rate: 0.003, sample_size: 920 },
  after_action: { error_rate: 0.081, sample_size: 1124 },
  delta: 0.078,
  threshold: 0.020,
  observation_window_s: 34,
  affected_namespace: "advocate"
}
```

This is what the controller knows: the measurement and the threshold. It deliberately does *not* attempt semantic explanation — *why* the metric moved is not the controller's job. The agent reads the mechanical reason on its next inference cycle, retrieves similar-pattern postmortems, and produces semantic interpretation in its postmortem.

This split-of-responsibility is the design point. The controller doesn't need a theory of the system. The agent does.

Implementation in [`breakage/src/speculative-exec/reason/`](../../breakage/src/speculative-exec/reason/).

## Revert-loop prevention

The controller enforces a hard limit: **N=2 reverts on the same scenario or incident**. After the second revert, the agent's normal loop pauses on the third attempt; the agent must produce an explicit analysis of why the previous attempts failed and a request for human review *before* the next action runs.

Without this limit, an unhealthy agent loop could oscillate indefinitely between "mutate" → "auto-revert" → "mutate" → "auto-revert," denial-of-service-ing its own incident. The limit converts that pattern into an escalation signal.

Implementation: the revert orchestrator increments a counter per `(scenario_id_or_incident_id)` and checks it before each new action that follows a revert. At N=2, the next action submits an `escalation` event instead of executing.

## What the controller does *not* do

- **Multi-resource Helm releases.** Single-resource model only. Tier-3-gated for now.
- **Operator-reconciled custom resources.** Reconciliation order, dependent-resource creation, and webhook ordering complications keep CRDs out of the snapshot scope.
- **Cross-cluster coordination.** Single-cluster model.
- **Predictive analysis.** The controller is reactive — it watches what already happened. Predictive-revert (revert the action before it lands, based on likely outcome) is Phase 2+ research.

These are documented in [`planning/phase-1-breakage-framework.md`](../../planning/phase-1-breakage-framework.md) §8 as "Week-1 scope" and "Phase 2+ maturity."

## Why this enables "fix live"

Most autonomous-agent designs for ops force the trade-off: either the agent has authority and blast radius is unbounded, or the agent only proposes (a PR, a runbook entry) and an operator accepts the latency.

The controller's design declines the trade-off. The agent has authority. Blast radius is bounded by the snapshot + watch window. The latency cost is the watch window itself (~30-60s typical) plus the cost of one occasional auto-revert when the agent gets it wrong.

In production-incident terms: the alternative to the controller-bounded autonomous loop is a human SRE making the same decisions in 5-15 minutes. The controller's per-action cost (snapshot + watch + occasional revert) is a fraction of that, and it scales — the controller doesn't tire, doesn't context-switch, and doesn't have a different judgment between 3 a.m. and 9 a.m.

## How this composes with tier-based approval

[Tier-based approval](tier-based-approval.md) is the *complement* to speculative execution. Tier 2 actions go through the controller (autonomous, reversibility ≤ 0.3, snapshot-bounded). Tier 3 actions go through human approval (synchronous, reversibility 0.7-1.0, the snapshot system can't safely revert them).

The two systems split the action surface: tier 2 is "the controller can recover from this," tier 3 is "the controller can't, so a human gates it." The decision boundary is documented per-tool in `operator/src/tools/<tool>.ts`'s `tier` annotation.

## Verifying the controller works

End-to-end check, from the framework's verification list:

> **Auto-revert works with mechanical reason.** Inject a scenario where the agent's first action causes a regression; confirm controller snapshotted pre-action, detected regression within SLO-watch window, reverted automatically, and emitted a mechanical reason (specific metric + delta + time). The agent's next postmortem converts the mechanical reason into a semantic diagnosis.

> **Revert-loop prevention fires at N=2.** Force a scenario where the agent's first two attempts both regress and auto-revert. On the third attempt, confirm the normal loop pauses, an analysis of why previous attempts failed is produced, and a human-review request is raised before any further action.

Both are scenarios in the anchor library. Running them against an unmodified agent should pass.
