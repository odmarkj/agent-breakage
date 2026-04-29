# SRE Book ch. 22 — Addressing Cascading Failures

Coverage tranche seeded from [Google SRE Book, Chapter 22](https://sre.google/sre-book/addressing-cascading-failures/). Scenarios in this directory exercise Emily's diagnostic behavior on the failure modes the chapter names.

## Why this chapter

Ch. 22 is the single densest source of real-world cascade patterns any k8s operator will encounter: connection-pool exhaustion, retry storms from slow startup, capacity loss amplification under sustained load, and the "death spiral" where a partial outage feeds itself. None of these are visible from a single resource's manifest — the symptom surface is always "pods not healthy", but the root cause hides in interaction effects between load, probe timing, retry policy, and resource envelope.

Emily's strength on isolated anchor scenarios (patch-a-manifest-and-fix) doesn't transfer automatically to cascades. This tranche is designed to catch where her diagnostic approach fails when the problem requires reading across multiple signals.

## Scope

All scenarios target the `prod-advocate` fixture in the k3d-scenarios cluster — the same fixture anchor scenarios use. This keeps the tranche runnable from the existing baseline harness without new cluster setup.

Each scenario uses **existing** injectors (`deployment-patch`, `secret-content`) only. Cascades that genuinely require multi-service topology or real traffic generators are listed in COVERAGE.md as "future-work" so the tranche can grow without blocking on infra work.

## Seeded (Week 2)

| Scenario | Pattern (SRE Book §) | Ground-truth category |
|---|---|---|
| `slow-startup-retry-storm-advocate` | "Why Do Servers Fail to Serve Traffic?" — probe thrashes under startup latency | `probe-misconfigured` |
| `replica-loss-amplification-advocate` | "The Death Spiral" — fewer servers, unchanged load, survivors drown | `deployment-rollout-failure` |

> **Attempted and retired:** `connection-pool-exhaustion-advocate` required the fixture to expose a real connection pool knob (env var or arg). The k3d-scenarios advocate-api fixture is a busybox shell script with no pool. Tracked in COVERAGE.md as a ⏳ pattern pending a fixture upgrade.

See COVERAGE.md for the full pattern map and what's still to-do.

## Running

```bash
# Single scenario:
./scripts/scenario-run.sh replica-loss-amplification-advocate

# Full tranche (once npm run batch supports --tranche, TODO Week 3):
npm run batch -- --tier=coverage --tranche=sre-book-ch22-cascading --reps=3
```

## Provenance

Each scenario's `origin` field cites the SRE Book chapter section it draws from, so reviewers can map framework coverage back to the source.
