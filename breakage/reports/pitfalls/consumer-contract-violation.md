# Pitfalls draft — consumer-contract-violation

**Generated:** 2026-04-24T18:15:33.396Z
**Corpus:** 1 regressed postmortem(s) with primary_category=`consumer-contract-violation`

> Auto-generated from the experience base by `npm run pitfalls`. This is a
> **DRAFT for human review**, not a directive. Do not feed the entries below
> into Emily's context without reviewing each one against the underlying
> incidents. Phase-1 §16 explicitly defers automated injection of this
> output into Emily's reasoning until Phase 5+.

---

## Action-sequence patterns that preceded regressions

_No repeated action-sequence patterns met the min-occurrences threshold (2)._

## Dead-ends Emily self-reported

- Swapping the served model to resolve a pod availability issue — model identity is a consumer-facing contract, not a knob. Dimension change would have silently corrupted every downstream vector store.
- Retrying the same manifest patch after the human reverted it — violates the N=2 revert-loop principle (plan §8). A manifest that keeps being reverted is a signal to escalate, not re-apply.
- Image tag churn (cpu-1.5 → cpu-1.7 → cpu-1.8 in quick succession) without reading the first failure's root cause. cpu-1.5's `Error: Could not download model artifacts (relative URL without a base)` was diagnosable from the logs.
- Treating platform-* namespaces the same as service namespaces. platform-embeddings is shared infra whose consumers (postmortem retrieval, lde-dash chunker) have contracts that are not readable from the Deployment manifest alone.
- Acting on a pod that's been crash-looping for less than a minute. Model-loading pods legitimately take 30-60s on first boot; early intervention pre-empts the normal path.

## Sample diagnoses from regressed postmortems

> bge-m3 in ONNX on CPU OOMed during model warmup because the default max_batch_tokens (16384) × 8192 token context × fp32 activations exceeded the pod's 3.5Gi memory limit. Correct fix: raise the memory limit to 6Gi and set `--max-batch-tokens=2048 --max-client-batch-size=8` so warmup allocates less activation memory. The model identity itself is a consumer-facing contract (embedding dimension flows into the pgvector column spec and every indexed corpus) and is NOT a parameter the operator can safely tune to resolve a pod availability issue.

---

## Reviewer checklist

- [ ] Are the top-count patterns genuinely bad behaviors Emily should avoid, or coincidence?
- [ ] Are there specific fix templates Emily should try FIRST for this category?
- [ ] Is there context missing from Emily's postmortem schema that would have disambiguated these regressions?
- [ ] If this pattern is real, promote to a `known_pitfalls` entry in `context/playbooks/<category>.yaml` (Week 5+).
