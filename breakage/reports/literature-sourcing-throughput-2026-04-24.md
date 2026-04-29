# Literature-sourcing throughput analysis — 2026-04-24

Answers the question the external reviewer raised about corpus-density accrual, but reframed for our actual sourcing strategy: **prod incidents are not the corpus source. Externally-sourced real-world k8s incidents, reproduced on a demonstration application, are.** This makes the ceiling a function of authoring hours and available source material — not of prod incident frequency.

## Current state

### Corpus

| Source | Count |
|---|---|
| incident-log (hand-authored from real incidents / literature) | 11 |
| scenario (accumulated from runs) | 229 |
| **total** | **240** |

### Scenarios in library

| Tier | Count |
|---|---|
| anchor | 9 (oom-advocate-api is `regression-watch` — effective count 9, not 10) |
| coverage | 10 |
| **total** | **19** |

Plan §14 target for Phase 1: 60–80 scenarios across anchor + coverage + incident-derived. **Gap: ~45 scenarios.**

Plan §10 target for experience base: 200+ postmortems across categories by end of Week 4. **Current incident-log gap: ~189 postmortems.** (Scenario postmortems count toward corpus density but aren't controlled/curated the way incident-log entries are.)

### Coverage tranches documented todo state

| Tranche | ✅ covered | 🟡 partial | ⏳ todo | Total named patterns |
|---|---|---|---|---|
| sre-book-ch22-cascading | 2 | 3 | 7 | 12 |
| k8s-troubleshooting | 3 | 5 | 9 | 17 |
| otel-demo-flagd-faults | (5 shipped, COVERAGE.md not updated) | — | — | — |

## Authoring throughput

### Measured: today's 4 seed postmortems

- `cpu-throttling-engine-vcpu-half-2026-03-12`: ~20 min
- `cpu-throttling-publisher-reviews-rps-burst-2026-04-12`: ~20 min
- `replica-scale-down-partial-hpa-misfire-2026-02-24`: ~25 min
- `replica-manual-scale-zero-by-mistake-2026-03-28`: ~22 min

Mean: **~22 min per incident-log postmortem** (including diagnosis prose, actions_taken with reversibility, what_did_not_work, metadata, formatting).

### Scenario YAML authoring

From earlier Week-2 work (SRE Book + k8s-troubleshooting tranches): ~30-45 min per scenario YAML including mutation design, detector condition authoring, ground_truth classification, and the one-time decision of which injector type to use. Second-and-subsequent scenarios in the same tranche trend toward the faster end because the patterns stabilize (plan §timeline acknowledges this: "Scenario creation accelerates in weeks 3-4 as patterns stabilize (~3-4 hrs/scenario for coverage tier)" — that 3-4 hour number included per-scenario detector design and was measured on more complex setups than our current pattern).

Current measured: **~35-40 min per coverage scenario YAML** once the injector type is reused.

### Paired authoring (scenario + seed postmortem together)

For most coverage scenarios, the scenario YAML needs to be paired with a seed postmortem describing a past instance of that pattern — this is how we get the dense per-mechanism corpus retrieval relies on. Paired authoring: ~60 min (35 min scenario + 22 min seed + some coordination overhead).

## Ceiling analysis

### Source material is not the bottleneck

- **Google SRE Book** (ch. 21-22 alone): ~30 distinct cascade + overload patterns
- **CNCF postmortems repo** (github.com/cncf/surveys/issues + public writeups): hundreds of real incidents, many reproducible
- **Kubernetes docs "Debug Running Pod"**: ~20 distinct first-90-days patterns
- **AWS Well-Architected Ops pillar**: dozens more
- **Jepsen reports**: ~40 distributed-system failure modes
- **Gremlin chaos engineering taxonomy**: ~50 deliberately-injectable patterns
- **Individual company postmortems** (GitLab, Cloudflare, GitHub, AWS public docs): hundreds of writeups, most with enough detail to reproduce

Total named, documented, reproducible patterns: **low thousands.** The library could grow to 500+ scenarios without exhausting the source material.

### Demonstration-app is a real constraint

The current `prod-advocate` fixture is `busybox:1.37` + a shell script. It supports manifest-level faults (image, env vars, probes, replicas, resource limits) but NOT app-level faults (connection pool exhaustion, application-error-race-condition, cache invalidation, DB connection drops, queue backpressure). The `otel-demo-flagd-faults` tranche was authored against a separate OTel Demo fixture to bridge this gap but is larger-infra to run.

**Implication**: reaching plan-target library size (60–80) is achievable with the current fixture for k8s-plane patterns (~40-50 of the 80), but full library coverage requires either (a) an expanded demo app with app-level knobs or (b) expanded reliance on OTel Demo.

## Projected effort to hit plan §14 targets

Assuming paired authoring at 60 min/unit for coverage, 30 min/unit for incident-log-only (when no scenario accompanies it), and ~40 min/unit for anchor scenarios (more care on detector conditions):

| Target | Gap | Effort estimate |
|---|---|---|
| 15 anchor scenarios | +6 anchors | ~4 hrs |
| 45-65 coverage scenarios (paired with seeds) | +35-55 | ~35-55 hrs |
| 200+ incident-log postmortems | +189 | ~70 hrs if seed-only; included above if paired |

**Total to reach plan §14 lower-bound**: ~40-60 hours of focused authoring. At 4 hrs/day sustainable focus, that's 2-3 weeks of part-time work.

This is materially less than the reviewer's worst-case "2+ years before production-driven compounding reaches useful density." Literature-driven sourcing bypasses the production-incident-rate bottleneck entirely.

## What this means for the decision

If the falsification test (running in parallel) shows retrieval compounds on the 3 dense-corpus scenarios with statistical significance, then:

- The core mechanism works when the corpus has per-mechanism density.
- Per-mechanism density is reachable via ~60 hours of paired authoring from public literature.
- The "corpus sparsity is structural" concern evaporates because we're not waiting for prod incidents.

The bottleneck shifts from "system produces enough incidents to feed the loop" (which would have been structural, and unsolvable for a well-run cluster) to "author has enough hours to seed the initial corpus from public sources" (which is bounded, predictable, and one-time-ish).

## Recommended sequencing if the falsification test passes

1. **Days 1-3**: author 2-3 paired (scenario + seed) postmortems per existing COVERAGE.md pattern. Target 12-15 new scenarios, doubling library size to ~30.
2. **Day 4**: re-baseline at 3 reps per scenario on the expanded library. Per-scenario deltas indicate which newly-authored scenarios retrieve usefully vs not.
3. **Days 5-7**: add 2-3 more paired units for any scenario where retrieval underperformed — same targeted-seeding strategy that worked for cpu-throttling/replicas-loss.
4. **Week 2**: expand demo app (or OTel Demo usage) to cover app-level failure modes. Author ~20-30 more paired units across connection-pool, DB-failure, network-failure tranches.
5. **Week 3**: scorecard-of-record at 5 reps/scenario against the expanded library. Week-5 playbook decision based on which categories retrieval didn't cover.

**Total**: ~3 weeks to plan §14 target + launch-candidate scorecard.

If the falsification test fails, these efforts pivot as described in the prior recommendation.
