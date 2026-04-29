# Pitfalls draft — configuration-error

**Generated:** 2026-04-24T18:15:33.396Z
**Corpus:** 2 regressed postmortem(s) with primary_category=`configuration-error`

> Auto-generated from the experience base by `npm run pitfalls`. This is a
> **DRAFT for human review**, not a directive. Do not feed the entries below
> into Emily's context without reviewing each one against the underlying
> incidents. Phase-1 §16 explicitly defers automated injection of this
> output into Emily's reasoning until Phase 5+.

---

## Action-sequence patterns that preceded regressions

Emily's actions in order of how often the sequence preceded a regressed outcome.
Higher-count patterns are higher-priority review targets.

| Count | Action sequence | Example incidents |
|-------|-----------------|-------------------|
| 2 | `SET: kubectl_apply + kubectl_describe + kubectl_get + kubectl_logs` | `secret-missing-key-advocate-214c58d7-9b5f-45ad-a196-f00f86d84e7d`, `secret-missing-key-advocate-a1b4f60e-5473-4997-a083-169d54e65da5` |

## Dead-ends Emily self-reported

- Initial hypothesis: Image pull error from ghcr.io (403 Forbidden) - this was resolved in previous investigation; current pods successfully pull busybox:1.37 but fail at runtime
- Assumed the pod mentioned in goal would still exist - it was recycled by the deployment controller and replaced with new replicas
- Initial investigation suggested the pod from the original goal (advocate-api-7d4946987b-fpsgm) still existed - it was actually already deleted.
- Assumed the first pod (advocate-api-665b57b976-s7h87) was failing due to startup issues, but it actually started successfully and was deliberately terminated due to a subsequent deployment update.

## Sample diagnoses from regressed postmortems

> The advocate-api pods are in CrashLoopBackOff due to a missing SESSION_SECRET key in the advocate-secrets Secret. The secret's annotation shows SESSION_SECRET was previously configured (base64: dGVzdC1zZXNzaW9uLXNlY3JldC00OC1jaGFycy1sb25nLWZvci1yZWFsaXNtLW9r), but the current secret data only contains ANTHROPIC_API_KEY and DATABASE_URL. The container startup script explicitly requires all three environment variables and exits with code 2 when SESSION_SECRET is missing or empty.

> The pod `advocate-api-689875fbdc-74gbh` was experiencing back-off restarts because the container was exiting with exit code 2. The root cause is that the Kubernetes secret `advocate-secrets` in the `prod-advocate` namespace is missing the `SESSION_SECRET` key. The secret was originally created with three keys (ANTHROPIC_API_KEY, DATABASE_URL, and SESSION_SECRET), as shown in the `last-applied-configuration` annotation, but the `SESSION_SECRET` key has been deleted from the actual secret data. The pod startup script requires this environment variable and explicitly exits if it's empty: `if [ -z "$SESSION_SECRET" ]; then echo "[advocate-api] SESSION_SECRET is empty" >&2; exit 1; fi`. Without this key present in the secret, every pod creation fails immediately during initialization, causing the CrashLoopBackOff restart cycle.

---

## Reviewer checklist

- [ ] Are the top-count patterns genuinely bad behaviors Emily should avoid, or coincidence?
- [ ] Are there specific fix templates Emily should try FIRST for this category?
- [ ] Is there context missing from Emily's postmortem schema that would have disambiguated these regressions?
- [ ] If this pattern is real, promote to a `known_pitfalls` entry in `context/playbooks/<category>.yaml` (Week 5+).
