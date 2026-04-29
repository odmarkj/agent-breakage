# operator/docs/ — agent architecture documentation

External-reader documentation for the operator agent ("Emily") that runs against the [breakage framework](../../breakage/docs/).

The agent's autonomous-repair authority is bounded by four interlocking systems. Each has its own document:

- **[Seven-layer hardening](seven-layer-hardening.md)** — the structural defenses that make specific destructive actions impossible at the infrastructure level. Built incrementally in response to specific incidents.
- **[Tier-based approval](tier-based-approval.md)** — how Tier 1 / Tier 2 / Tier 3 tools get gated. Synthetic approver for scenario testing.
- **[Speculative-execution controller](speculative-execution.md)** — snapshot + watch + auto-revert envelope around Tier-2 mutations. Why "fix live" is safe.
- **[Reversibility classification](reversibility-classification.md)** — the per-tool 0.0-1.0 scalar that informs the agent's own action selection and weighs into the framework's `no_regressions` scoring.

Reading order if you're new to the agent: start with [reversibility](reversibility-classification.md) for the basic vocabulary, then [tiers](tier-based-approval.md) for the human-approval surface, then [speculative-execution](speculative-execution.md) for what makes Tier 2 autonomous-but-bounded. Read [hardening](seven-layer-hardening.md) last — it's the longest and most incident-specific.

## What this is *not*

These docs describe the *agent's* architecture — its tool surface, its decision constraints, its autonomy envelope. They don't describe:

- How to *use* the agent in production (deployment, monitoring, on-call interaction patterns).
- How to *modify* the agent's reasoning model (system prompts, tool routing, retrieval-augmented inference). The agent's prompt-building lives in [`operator/src/breakage/prompt-sections.ts`](../src/breakage/prompt-sections.ts) and the model selection in [`operator/src/agent.ts`](../src/agent.ts).
- The cluster-state mutation surface itself. That's documented in [`context/mutation-safety.md`](../../context/mutation-safety.md) for the agent's own consumption.

## What "Emily" is

In this codebase the agent is referred to as Emily. The naming is a project convention — an autonomous Kubernetes operator running in a single k3s cluster, against the AI-managed-AI thesis that operations agents need rigorous measurement before they can safely take on more authority.

The breakage framework is what measures Emily. The docs here describe Emily-the-system. The docs in [`breakage/docs/`](../../breakage/docs/) describe the measurement surface around her.
