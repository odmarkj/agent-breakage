# Kubernetes troubleshooting patterns

Coverage tranche drawing from the k8s community's shared troubleshooting canon: the [Kubernetes docs "Debug Running Pods"](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/) chapter, the [kubectl cheat sheet debug patterns](https://kubernetes.io/docs/reference/kubectl/cheatsheet/), and the top-voted StackOverflow `kubernetes` tag recipes.

## Why this tranche

This is the "first 90 days" set — the symptoms any cluster operator encounters in week one. They're pedagogically cleaner than the SRE-book cascade scenarios: one root cause, one surface symptom, one fix. Together they establish a floor for Emily's competence: if she can't reliably diagnose "pod stuck Pending because resources request too high," she shouldn't be autonomous on cascades either.

## Scope

All scenarios target `prod-advocate` in k3d-scenarios (reuses anchor fixture). Existing injectors only — no new injector types authored for this tranche.

## Seeded (Week 2)

| Scenario | Surface symptom | Ground-truth category |
|---|---|---|
| `pod-pending-request-too-high-advocate` | Pod stuck Pending, 0/1 nodes available | `deployment-rollout-failure` |
| `bad-command-crashloop-advocate` | CrashLoopBackOff with immediate exit | `application-error-uncaught-exception` |
| `serviceaccount-missing-advocate` | Pods never admitted (SA not found) | `deployment-rollout-failure` |

See COVERAGE.md for the broader pattern list and what's pending.

## Running

```bash
./scripts/scenario-run.sh bad-command-crashloop-advocate
```

## Source discipline

Each scenario's `origin` field should cite the exact k8s doc section, StackOverflow thread tag, or GitHub issue that surfaces the pattern. If a scenario's origin is `synthetic:*`, it's a made-up fault — flag in review whether it truly reflects a real-world pattern or is testing infrastructure for its own sake.
