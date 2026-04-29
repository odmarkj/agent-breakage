# Coverage tracking — otel-demo-flagd-faults

Auto-parseable coverage report. Machine queries scan for `covered: yes | no` rows.

| flag | file | category | covered |
|------|------|----------|---------|
| adFailure | — | application-error-uncaught-exception | no |
| adHighCpu | — | resource-limit-misconfiguration | no |
| adManualGc | — | application-error-uncaught-exception | no |
| cartFailure | cart-failure.yaml | application-error-uncaught-exception | yes |
| emailMemoryLeak | email-memory-leak.yaml | resource-limit-misconfiguration | yes |
| failedReadinessProbe | — | probe-misconfigured | no |
| imageSlowLoad | — | adversarial | no |
| kafkaQueueProblems | kafka-queue-problems.yaml | queue-backpressure | yes |
| llmInaccurateResponse | — | adversarial | no |
| llmRateLimitError | — | connection-pool-exhaustion | no |
| loadGeneratorFloodHomepage | — | adversarial | no |
| paymentFailure | payment-failure.yaml | application-error-uncaught-exception | yes |
| paymentUnreachable | — | dns-resolution-failure | no |
| productCatalogFailure | — | application-error-uncaught-exception | no |
| recommendationCacheFailure | recommendation-cache-failure.yaml | connection-pool-exhaustion | yes |

Summary: 5 / 15 covered.
