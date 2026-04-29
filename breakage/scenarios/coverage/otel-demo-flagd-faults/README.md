# Coverage tranche: OpenTelemetry Demo — flagd feature-flag faults

## Source

[OpenTelemetry Demo](https://opentelemetry.io/docs/demo/) ships with a [flagd](https://github.com/open-feature/flagd) feature-flag service whose `flagd-config` ConfigMap defines 15 faults. Each flag, when its `defaultVariant` is flipped (typically `"off"` → `"on"`), triggers a specific failure in a specific service. Operating ops teams get realistic multi-service cascade behavior because the target services already interact via HTTP + Kafka + Postgres + Redis, with Locust generating continuous user traffic.

This tranche uses our `flagd-flag` injector type to exercise those faults as scenarios. The injection mechanism is identical across scenarios (`flagd-flag` toggles a ConfigMap entry, flagd's FS watcher picks up the change in ~1-2s); what varies is which flag is set and which downstream symptoms Emily has to diagnose.

## Prerequisites

OTel Demo must be running in the `otel-demo` namespace before these scenarios can execute. Bring up via:

```bash
./scripts/target-otel-demo.sh up
```

Tear down when done with the test session — it's ~28 pods and shouldn't be left running.

## Coverage

Flags are listed in the canonical order they appear in OTel Demo's `flagd-config` ConfigMap. ✅ = scenario exists in this tranche. ⬜ = flag available but no scenario yet.

| flagd flag                         | Scenario file                              | Maps to category                     | Status |
|------------------------------------|--------------------------------------------|--------------------------------------|--------|
| adFailure                          | —                                          | application-error-uncaught-exception | ⬜     |
| adHighCpu                          | —                                          | resource-limit-misconfiguration      | ⬜     |
| adManualGc                         | —                                          | application-error-uncaught-exception | ⬜     |
| cartFailure                        | cart-failure.yaml                          | application-error-uncaught-exception | ✅     |
| emailMemoryLeak                    | email-memory-leak.yaml                     | resource-limit-misconfiguration      | ✅     |
| failedReadinessProbe               | —                                          | probe-misconfigured        | ⬜     |
| imageSlowLoad                      | —                                          | adversarial (slow-loading)           | ⬜     |
| kafkaQueueProblems                 | kafka-queue-problems.yaml                  | queue-backpressure                   | ✅     |
| llmInaccurateResponse              | —                                          | adversarial (misleading)             | ⬜     |
| llmRateLimitError                  | —                                          | connection-pool-exhaustion (rate)    | ⬜     |
| loadGeneratorFloodHomepage         | —                                          | adversarial (DoS)                    | ⬜     |
| paymentFailure                     | payment-failure.yaml                       | application-error-uncaught-exception | ✅     |
| paymentUnreachable                 | —                                          | dns-resolution-failure (variant)     | ⬜     |
| productCatalogFailure              | —                                          | application-error-uncaught-exception | ⬜     |
| recommendationCacheFailure         | recommendation-cache-failure.yaml          | connection-pool-exhaustion           | ✅     |

**Phase 1 target**: 5 scenarios covered. The remaining 10 can be added as coverage scenarios any time the framework demands more breadth in these categories.

## Why flagd-flag scenarios are "coverage" not "anchor"

Anchor scenarios are deep-validated against real production-incident history. These flagd-based scenarios are synthetic in that the failure modes come from a demo catalog rather than documented incidents in our own cluster — but they exercise the same failure classes with the realism advantage of multi-service cascade behavior in a real workload. Treat their scorecard signal as directionally useful but less authoritative than anchor-tier.

If one of these scenarios reveals a consistent Emily capability gap in some real category (say, Emily never correctly diagnoses `queue-backpressure` despite our vocab entry), we promote it to anchor tier by adding rigorous noise-floor validation and 5-rep scoring — and by that point, we likely have a real production incident to ground the `origin` field in.

## Detector conventions for this tranche

OTel Demo exposes Prometheus metrics with OpenTelemetry semantic conventions:
- `http_server_request_duration_seconds_count` with labels `http_response_status_code`, `k8s_namespace_name`, `service_name`
- Service-specific metrics surface under the `app_*` namespace (e.g., `app_frontend_requests_total`)

Scenarios here use the `error_rate{ns=otel-demo}` shorthand and `promql:` explicit queries as needed. When a flag targets a specific service, detector scope is narrowed to that service via the namespace filter.
