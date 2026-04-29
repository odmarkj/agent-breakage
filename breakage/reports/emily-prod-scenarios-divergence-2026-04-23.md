# Prod vs scenarios Emily divergence audit — 2026-04-23

Per the external review: if prod Emily is a different codebase state from scenarios Emily, the scorecard doesn't gate what ships. This audit captures today's divergence and the path to unification.

## Current state

### ConfigMap content — **aligned** (after today's sync)

| Key | Prod | Scenarios | Worktree | Status |
|---|---|---|---|---|
| `cluster.md` | ✓ | ✓ | ✓ | identical (md5 `f045ba2e`) |
| `mutation-safety.md` | ✓ | ✓ | ✓ | identical (md5 `73cca8d3`) — includes "platform-* Deployments have hidden consumer contracts" section |
| `services.md` | ✓ | ✓ | ✓ | identical |
| `service-repos.md` | ✓ | ✓ | ✓ | identical |
| `root-cause-categories.yaml` | ✓ *(synced today)* | ✓ | ✓ | identical — prod now has Emily's vocab rendering input |

After today's `sync-emily-context.sh --prod`, both clusters' `operator-context` ConfigMaps are byte-identical to the worktree source of truth.

### Image — **divergent, needs release cycle**

| Cluster | Image | Source |
|---|---|---|
| Prod k3s | `ghcr.io/odmarkj/k8s-operator:latest` | CI build from `main` branch |
| k3d-scenarios | `k3s-operator:scenarios` | local `docker build` from the worktree |

**This is the load-bearing divergence.** Every Phase-1 code change lives on the worktree and has not been merged to `main`:

```
21 modified/untracked files
 M operator/src/{agent,goals/executor,tools/*}.ts    ← reversibility, shared prompt, updated tool surface
 M operator/src/types.ts                              ← tier + reversibility fields
?? operator/src/breakage/                             ← retrieval client, prompt sections, playbooks, vocab
?? operator/src/tools/hypothesis.ts                   ← emit_hypothesis tool
?? operator/src/tools/postmortem.ts                   ← write_postmortem tool
?? breakage/                                          ← whole framework
?? context/playbooks/                                 ← playbook YAMLs
?? services/embeddings/                               ← shared bge-m3 TEI service
```

Concretely, prod Emily is missing:
- The `emit_hypothesis` and `write_postmortem` tools.
- The `BREAKAGE_RUNNER_URL`-gated retrieval path in the agent loop.
- Shared prompt sections (synthetic-approval, vocab, retrieval, playbooks).
- Reversibility metadata on tool definitions.
- Updated error-surfacing on postmortem-rejected rejections.

The ConfigMap sync made prod Emily's **context** match the worktree, but her **code** doesn't consume much of that context yet. The ConfigMap's `root-cause-categories.yaml`, for instance, is only rendered into the system prompt by `renderVocabSection` — which lives in the worktree, not in `main`.

## What Phase-1 work is safe to ship to prod

All of it, with caveats. The Phase-1 surface is gated behind `BREAKAGE_RUNNER_URL`: when that env var is unset (prod's current state), `isBreakageEnabled()` returns false and every retrieval call is a no-op. What prod Emily DOES gain unconditionally from a `main`-merge:

- **`emit_hypothesis` and updated `write_postmortem`** — tools become available; emit_hypothesis is a no-op without a runner but doesn't hurt.
- **Shared prompt sections** — vocab + mutation-safety-style operational guidance get rendered into her system prompt. Strictly improves her reasoning quality.
- **Reversibility-aware action selection** — she reads each tool's reversibility scalar when choosing. Purely additive behavior.
- **Error surfacing on postmortem-rejected** — she sees runner 400/409 errors inline when scenario-running later; no-op in prod.

Nothing in the Phase-1 code path changes prod Emily's autonomous authority or adds new production side effects.

## Release path (proposed)

The cleanest sequence:

1. **Branch** — commit the 21 worktree files to a PR branch. Staging area is clean enough that a single commit "Phase 1: breakage framework + Emily integration" is defensible; prefer 4–5 thematic commits (framework, experience-base, operator-tools, scenarios, services/embeddings) for review.
2. **CI** — open the PR against `main`. Confirm the existing `ghcr.io/odmarkj/k8s-operator:latest` pipeline builds cleanly.
3. **Canary** — before merge, rolling-update prod Emily to pull the PR branch's image (if the pipeline tags per-branch) and observe for 24 hours that her behavior hasn't regressed on real incidents.
4. **Merge + deploy** — merge PR, wait for `latest` to rebuild, `kubectl rollout restart deploy/k3s-operator -n operator` on prod.
5. **Reconfirm** — `sync-emily-context.sh --prod` one more time to ensure ConfigMap content is still aligned post-rollout.

## Ongoing: preventing silent re-divergence

New file: `operator/scripts/sync-emily-context.sh`. Bundles all `context/*.md` + the vocab YAML into `operator-context`, applies to prod or scenarios (or both), and rollout-restarts the deployment. Idempotent — safe to run periodically or from CI.

Recommended: add a weekly GitHub Action that runs `sync-emily-context.sh --prod --scenarios`. If anyone edits `context/*.md` on main without shipping the ConfigMap, the drift is ≤ 1 week.

## Out of scope for this audit

- Operator-secrets (API keys, etc.) — deliberately different per environment. No sync.
- `BREAKAGE_RUNNER_URL` — prod doesn't run a breakage runner; this env var stays unset in prod until Phase 1's full loop is ready for real production incident intake (plan-§ post-launch).
- Image digest pinning — prod pulls `:latest` which is convenient but non-reproducible. Moving to digest-pinned deploys is a separate improvement outside this audit.
