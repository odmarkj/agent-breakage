# Pitfalls draft — secret-content-mismatch

**Generated:** 2026-04-24T18:15:33.397Z
**Corpus:** 1 regressed postmortem(s) with primary_category=`secret-content-mismatch`

> Auto-generated from the experience base by `npm run pitfalls`. This is a
> **DRAFT for human review**, not a directive. Do not feed the entries below
> into Emily's context without reviewing each one against the underlying
> incidents. Phase-1 §16 explicitly defers automated injection of this
> output into Emily's reasoning until Phase 5+.

---

## Action-sequence patterns that preceded regressions

_No repeated action-sequence patterns met the min-occurrences threshold (2)._

## Dead-ends Emily self-reported

- Assumed the Secret was empty without base64-decoding the data field
- Tried cross-namespace secretKeyRef (refs are namespace-scoped)
- Invented a new password via ALTER USER instead of reading the existing canonical Secret
- Used `kubectl create secret | kubectl apply` pattern to 'update' one key, which actually replaces all keys

## Sample diagnoses from regressed postmortems

> ServiceHTTP5xxSpike on advocate. Emily ran `kubectl get secret advocate-secrets -o yaml`, saw base64 blobs in `data:`, did NOT decode them, concluded the Secret was empty. It was never empty — it contained DATABASE_URL plus API keys. From the misread premise: (1) patched Deployment to cross-namespace secretKeyRef (does not resolve), (2) rewrote DATABASE_URL without password (SCRAM failure), (3) ran `ALTER USER advocate WITH PASSWORD '<LLM-generated>'` and wrote that into advocate-secrets. Pods came up on the third attempt, but the `kubectl create secret … | kubectl apply` pattern replaced the whole Secret, wiping 7 other keys (ANTHROPIC_API_KEY, SESSION_SECRET, SENDGRID_API_KEY, etc.) — none recoverable.

---

## Reviewer checklist

- [ ] Are the top-count patterns genuinely bad behaviors Emily should avoid, or coincidence?
- [ ] Are there specific fix templates Emily should try FIRST for this category?
- [ ] Is there context missing from Emily's postmortem schema that would have disambiguated these regressions?
- [ ] If this pattern is real, promote to a `known_pitfalls` entry in `context/playbooks/<category>.yaml` (Week 5+).
