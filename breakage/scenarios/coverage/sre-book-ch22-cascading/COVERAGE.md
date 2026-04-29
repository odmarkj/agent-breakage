# Coverage map — SRE Book ch. 22

Tracks which patterns from the chapter have scenarios today and which are on the to-do list. Updated as new scenarios land.

## Status legend

- ✅ Covered — scenario exists, runs, and has a baseline
- 🟡 Partial — scenario exists but lacks a baseline or only exercises part of the pattern
- ⏳ To-do — pattern is worth covering; infra gap or authorship time is the blocker
- ⏭ Out-of-scope — pattern doesn't map onto a single-cluster synthetic scenario (e.g., multi-region traffic failover)

## Pattern map

| SRE Book § | Pattern | Status | Scenario |
|---|---|---|---|
| 22 intro | Overloaded server rejects all traffic | ⏳ | needs a request generator — future work with OTel Demo |
| "Why Do Servers Fail to Serve Traffic?" | Slow startup → probe failure → retry storm | ✅ | `slow-startup-retry-storm-advocate` |
| "Resource Exhaustion" § CPU | CPU contention → request latency → timeouts | 🟡 | `cpu-limit-throttling-advocate` (anchor) partially covers; dedicated coverage scenario pending |
| "Resource Exhaustion" § Memory | Memory pressure → OOM on dependent workload | 🟡 | `oom-advocate-api-k8s-only` (anchor) partially covers |
| "Resource Exhaustion" § Threads/connections | Connection pool exhaustion cascade | ⏳ | needs a fixture with a real connection pool (env var or arg knob). Author attempt 2026-04-23 retired — busybox fixture has no pool to exhaust. Move forward when the fixture grows a pooled component. |
| "Resource Exhaustion" § File descriptors | fd exhaustion → new connection failures | ⏳ | needs inotify/ulimit setup in fixture pod |
| "Service Unavailability" § Cascading unavailability | Replica loss under sustained load — death spiral | ✅ | `replica-loss-amplification-advocate` |
| "Preventing Server Overload" § Queueing | Queue backup under partial outage | ⏳ | needs real queue (redis, kafka) in the fixture |
| "Slow Startup and Cold Caching" | Cold cache miss cascade on restart | ⏳ | needs cache layer + traffic generator |
| "Triggering Conditions" § Process death | Probe kills healthy pods under load | 🟡 | `liveness-probe-always-fails-advocate` covers the always-fails case |
| "Triggering Conditions" § Updates | Rollout interacts badly with ongoing load | ⏳ | needs rollout + traffic concurrency |
| "The Death Spiral" — retry storm | Clients retry failed → compounding load | ⏳ | needs client-side retry config or real traffic source |
| "Load Shedding and Graceful Degradation" | Missing shedding → overload cascade | ⏭ | requires app-level shedding code; more codefix-agent scope than breakage-framework scope |

## Next-tranche candidates (Week 3 authoring priority)

1. **`cascading-cpu-contention-advocate`** — dedicated cpu-contention-under-traffic; anchor version only measures reachability
2. **`large-request-timeout-advocate`** — set client read timeout low + server latency high → retry storm
3. **`startup-probe-too-tight-advocate`** — startupProbe kills slow-starting pods before they're ready
4. **`initContainer-slow-advocate`** — blocking init container makes rollouts look stuck

## Known limits

- No request generator → every "under load" scenario is synthetic: we simulate the manifest-level effect of load, not load itself.
- No metrics backend (Prometheus) → cascading error_rate cascades can't be detected automatically; Emily diagnoses from K8s events + pod state only.
- Single-service scope → cross-service cascades (payment → checkout → cart) are in `otel-demo-flagd-faults`, not here.
