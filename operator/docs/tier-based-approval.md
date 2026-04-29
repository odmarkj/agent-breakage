# Tier-based approval

Every tool the agent can invoke is annotated with a *tier* (1, 2, or 3) plus a separate *reversibility* scalar. Tier governs human-approval gating; reversibility informs the agent's own action selection (see [reversibility-classification.md](reversibility-classification.md)). This document covers tier.

## The three tiers

**Tier 1 — read-only, auto-execute.** No side effects. No approval. The agent can run these freely. Examples: `kubectl_get`, `kubectl_describe`, `kubectl_logs`, `kubectl_top`, `helm_list`, `helm_status`, `read_file`, `list_files`, `emit_hypothesis`, `write_postmortem`, `suggest_command`.

Tier-1 tools are how the agent orients. They produce no audit-relevant state changes; logging is at the operational-trace level, not the audit level.

**Tier 2 — autonomous mutation, audit-logged.** Side effects exist but are reversible-via-snapshot. The speculative-execution controller (see [speculative-execution.md](speculative-execution.md)) snapshots state before each call, watches SLOs after, and auto-reverts on regression. The agent doesn't explicitly speculate — the controller wraps every Tier-2 invocation transparently.

Examples: `kubectl_scale`, `kubectl_exec`, `kubectl_rollout_restart`, `kubectl_rollout_undo`, `shell_exec`, `spawn_code_fix`. Tier 2 is where most autonomous repair happens.

**Tier 3 — destructive or data-modifying, requires human approval.** Operations that can't be safely speculated against, that change credentials, that affect cross-cutting state, or that have high blast radius. Examples: `kubectl_apply`, `kubectl_delete`, `postgres_query` (with DML), `helm_upgrade`, `helm_rollback`.

Tier 3 mutations *do not run* until a human approves through the Slack approval flow. There is no autonomous-bypass mechanism.

## How approval flows

When the agent calls a Tier-3 tool:

1. The agent's tool dispatch path inspects the tool's tier annotation. Tier 3 → it doesn't execute immediately; it posts an approval request to Slack with the exact `(tool, input)` tuple, the agent's stated reason, and a structured "approve/deny" UI.
2. The current goal transitions to a `blocked-on-approval` state. The agent's loop pauses on this branch but can continue other goals if any are pending.
3. The human approver sees the message, the inputs (decoded if base64), and clicks approve or deny.
4. **Approve**: the runtime executes the *exact* tuple from step 1 under the approver's audit identity (`slack:<username>`). The tool's output flows back into the agent's message stream as if it had executed inline. Goal continues.
5. **Deny**: the runtime returns a denial result with an optional reason (free-text from the approver). The agent treats this as a tool error and is prompted to attempt a different approach — see "denial-recovery" below.

The approval flow is symmetric in production and in scenarios. In scenarios, a *synthetic approver* substitutes for the human (see "Testing tier 3 with synthetic approver" below).

## Denial-recovery as first-class behavior

A common failure mode in tier-gated agents: when an action is denied, the agent retries the *identical* action a moment later, hoping for a different answer. The agent loop intentionally does not do this. On denial, the agent's prompt explicitly frames the denied tuple as "this approach was rejected; pick a different approach." The agent's next move is observed in the scenario harness's `denial-recovery` test category.

This means denials are productive in two ways:

1. They prevent the rejected action from happening.
2. They redirect the agent toward investigation or a different repair path.

If an agent's denial-recovery rate is poor (it tries the same action again), that's a measurable regression in scenarios with `tier-3-deny` injectors.

## Testing tier 3 with the synthetic approver

The `breakage/synthetic-approver/` service simulates a human approver. Configurable:

- `SYNTH_APPROVER_DELAY_MIN_MS` / `SYNTH_APPROVER_DELAY_MAX_MS` — randomized delay before responding (default 300-800 ms; realistic Slack-message timing).
- `SYNTH_APPROVER_DENY_RATE` — probability of denial per request (default 0; set to 0.2 for denial-recovery tests).

The synthetic approver emits the same audit-log shape as the real Slack handler. Scenarios that exercise the tier-3 path (~4-5 of the 15 anchor scenarios in the plan) run against it during baseline.

## Why these specific tier assignments

The line between Tier 2 and Tier 3 is "would I mind if this got auto-reverted by the speculative-execution controller after running?" If yes (because the action either can't be reverted, or its blast radius extends beyond the snapshot), it's Tier 3.

- `kubectl_apply` — Tier 3 because it can create resources that the snapshot doesn't track (a new Service, a new NetworkPolicy). Auto-revert can only restore what was snapshotted.
- `kubectl_delete` — Tier 3 because it's destructive at the K8s level. Even with a snapshot, restoring a deleted Pod doesn't restore an in-flight request that was dropped.
- `postgres_query` — Tier 3 because it affects database state, which the snapshot system doesn't cover. (And because of layered-defense Layer 2 — see [seven-layer-hardening.md](seven-layer-hardening.md) — DML at the postgres level requires a non-operator identity that only Tier-3 approval grants.)
- `helm_upgrade` / `helm_rollback` — Tier 3 because Helm's reconciliation order is non-trivial and partial-rollback is sometimes the wrong action.

The Tier-2 set is conservative: only operations whose pre-state can be captured in a snapshot of a small set of named resources, and whose effect is bounded to those resources.

## Reading the tier annotation in code

Each tool definition under [`operator/src/tools/`](../src/tools/) exports an object with a `tier` field. Example:

```typescript
export const kubectlScale: ToolDefinition = {
  name: 'kubectl_scale',
  description: '...',
  tier: 2,
  reversibility: 0.3,
  adminOnly: false,
  inputSchema: { /* ... */ },
  async execute(input) { /* ... */ },
};
```

The agent's prompt-building path reads the `tier` and `reversibility` of every tool it can call and renders them into a system-prompt section. The agent reasons over both at inference time when choosing actions. The runtime tier-gate is independent of the prompt rendering — even if the prompt were corrupted, Tier 3 still pauses on the runtime check before execution.

## Audit log

Every tier-2 and tier-3 invocation produces an audit-log entry containing:

- timestamp
- agent identity (always `system:serviceaccount:operator:k3s-operator` for tier 2; `slack:<username>` for tier 3)
- tool name + input tuple
- pre-snapshot pointer (tier 2)
- approval message reference (tier 3)
- result + post-snapshot pointer
- speculative-revert outcome (tier 2; if revert happened, mechanical reason and pre-snapshot restore status)

The log is structured for retrospective audit. In Phase 1 it lives in postgres in a dedicated `audit_log` table; downstream Phase 2+ work moves it to a tamper-evident store (the integration is documented but not in scope for this Phase 1 closeout).
