# Anchor-fail classification audit — 2026-04-23

Audit of the sub-threshold anchor scenarios to separate real capability gaps from measurement artifacts, before expanding the anchor library past 10.

## Method

For each sub-threshold anchor, read Emily's actual `final_diagnosis` prose and compare it to the scenario's `ground_truth.primary_category`. Bucket the scenario into one or more of:

- **(A) Reasoning failure** — Emily's diagnosis prose misidentifies the cause. The low score reflects a real capability gap.
- **(B) Vocabulary ambiguity** — Emily's prose correctly identifies the cause, but the vocab's category descriptions support multiple defensible picks and Emily chose one that isn't the ground_truth primary.
- **(C) Ground-truth miscoding** — scenario author chose a ground_truth that doesn't best describe the root cause, given the vocab's current descriptions.

Query used: all non-framework-error, non-empty-actions runs per scenario, inspecting `primary_category` pick and the first 500 chars of `final_diagnosis`.

## Scope

5 sub-threshold anchors. One — `oom-advocate-api` (63%) — is in `status: regression-watch` with a known Prom dependency and is explicitly not runnable in k3d-scenarios; excluded from this audit. Four audited:

- `env-var-missing-advocate` (56%)
- `secret-missing-key-advocate` (64%)
- `liveness-probe-always-fails-advocate` (70%)
- `oom-advocate-api-k8s-only` (73%)

Plus one coverage scenario (`bad-command-crashloop-advocate` at 70%) included because it shares a mechanism with `env-var-missing-advocate` — the cross-scenario inconsistency is the interesting finding.

## Per-scenario verdicts

### `env-var-missing-advocate` (56%) — **(A) + (C)**

Injector clears `env = []`. App's startup script hits `${SESSION_SECRET:?required}` and exits. Ground_truth: `deployment-rollout-failure`.

Emily's picks across 4 non-timeout runs:

| Pick | Score | Prose says |
|---|---|---|
| `probe-misconfigured` | 0.70 | "overly aggressive probe timing... initialDelaySeconds of only 2 seconds" |
| `deployment-rollout-failure` | 0.91 | "busybox:1.37 instead of advocate-api... pod is not actually running the advocate-api application" |
| `symptom-misdiagnosis` | 0.70 | "alert fired during a transient startup window, which is normal and expected" |
| (one earlier probe-misconfigured) | | — |

Observations:
- **(A) Reasoning failure.** Three of four runs diagnose causes that aren't the injected fault: probe timing (invented), fixture image (not the injection), or "false alarm" (missed the injection entirely). The one 0.91 run got a correct-but-wrong match — she diagnosed busybox-as-fixture but the ground_truth happened to match. Diagnosis prose doesn't align with reasoning.
- **(C) Ground_truth miscoding.** Cross-check with `bad-command-crashloop-advocate`, which uses the same mechanism (container exits immediately due to bad config) but has ground_truth `application-error-uncaught-exception`. Two scenarios, same mechanism, different ground_truths is incoherent.

Recommendation:
1. Switch `env-var-missing-advocate` ground_truth to `application-error-uncaught-exception` (match bad-command-crashloop). This makes "app exited due to bad input" a single category across scenarios.
2. Separately, author clearer context so Emily recognizes the busybox fixture as intentional. Either document it in `context/cluster.md` or choose a less-deceptive fixture image (e.g., a binary that explicitly identifies itself as "advocate-api test fixture").

### `secret-missing-key-advocate` (64%) — **mostly (B)**

Injector removes SESSION_SECRET key from advocate-secrets Secret. Ground_truth: `secret-content-mismatch` (broadened 2026-04-22 to cover missing-key case).

Picks across 28 non-timeout runs (wrong picks only):

| Pick | Count | Prose pattern |
|---|---|---|
| `deployment-rollout-failure` | ~6 | "manifest has been corrupted... image was replaced with busybox" (fixture-blame) OR "transient startup failure" (misses injection) |
| `application-error-uncaught-exception` | ~5 | (timeout stubs in most cases) |
| `configuration-error` | 2 | early runs before vocab broadening: correct prose, invalid category |
| `secret-missing` | 1 | correct prose: "SESSION_SECRET key was removed" — just picked sibling vocab term |

Observations:
- **(B) Vocabulary ambiguity (majority).** When Emily correctly reasons about the secret (most runs), she picks `secret-content-mismatch` and scores 0.91. When she picks `secret-missing`, her prose is correct — she just grabbed the similarly-named sibling category. Post-vocab-broadening this happens rarely but hasn't been scrubbed from history.
- **(A) Reasoning failures** on some runs (fixture-blame) overlap with the pattern in env-var-missing.
- The low mean (64%) is pulled down by many timeout-stub 0.2 / 0.5 runs from pre-fix-era, not current reasoning quality.

Recommendation:
1. Keep ground_truth as-is; vocab broadening already aligns description with scenario.
2. Partial-credit scoring (co-occurring categories) would rescue the `secret-missing` picks without awarding full credit.
3. Most of the low mean is historical stub pollution. If we re-compute restricted to post-2026-04-22 runs, mean rises substantially.

### `liveness-probe-always-fails-advocate` (70%) — **pure (B)**

Injector sets liveness probe path to a bogus URL. Kubelet kills pods in a loop. Ground_truth: `probe-misconfigured`.

Picks across 2 non-timeout runs:

| Pick | Score | Prose says |
|---|---|---|
| `probe-misconfigured` | 0.91 | "liveness probe path `/liveness-that-does-not-exist`... root cause was a broken Deployment specification" |
| `deployment-rollout-failure` | 0.70 | "misconfigured liveness probe that was checking for a path `/liveness-that-does-not-exist` which the busybox httpd container was not serving... caused Kubernetes to kill the pod" |

Observations:
- Both runs **correctly identify the liveness probe as the cause**. The lower-scoring one is an archetype (B) case — Emily's prose names the probe verbatim, but she picks the effect category (`deployment-rollout-failure`) instead of the cause category (`probe-misconfigured`).
- This is the clearest evidence that the scoring layer, not Emily, is the problem on this scenario.

Recommendation:
1. Partial-credit scoring (co-occurring categories) would turn this 0.70 into ~0.85 — the reasoning is entirely correct.
2. Add `deployment-rollout-failure` as an acceptable `secondary_categories` entry in the scenario YAML, so scoring acknowledges the effect-layer validity.

### `oom-advocate-api-k8s-only` (73%) — **(A) + (C)**

Injector drops memory limit to 32Mi. Ground_truth: `resource-limit-misconfiguration`. The k3d-friendly variant of oom-advocate-api.

Picks across 14 non-timeout runs:

| Pick | Count | Notes |
|---|---|---|
| `resource-limit-misconfiguration` | 6 | Correct; 0.91 each |
| `deployment-rollout-failure` | 6 | Mostly fixture-blame ("busybox:1.37 instead of advocate-api") |
| `secret-missing` | 2 | **Cross-scenario contamination** — Emily diagnosed a secret issue on an OOM scenario |

Observations:
- **(A) Reasoning failure, deep.** Nearly half of wrong picks blame the busybox fixture or report prior-run contamination. These aren't vocabulary issues — Emily is reading the state incorrectly.
- **(C) Fixture design issue.** The k3d-scenarios advocate-api fixture IS busybox by design, but Emily has no way to know that. From her perspective, the "advocate-api" image being busybox LOOKS like a manifest corruption. This scenario would benefit from fixture-visibility docs in `context/cluster.md`.
- **(C) State leakage between runs.** The `secret-missing` picks on OOM scenarios suggest fixture reset between scenarios isn't thorough — prior runs' damage visible. `scripts/target-advocate.sh reset` needs hardening or the runner needs a more thorough between-run cleanup.

Recommendation:
1. Document the busybox fixture as intentional in `context/cluster.md` so Emily stops blaming the fixture image.
2. Strengthen the fixture-reset step in `scripts/scenario-run.sh` to guarantee no state leaks across runs (delete + recreate the advocate-api Deployment and Secret every time, not just patch).
3. After (1) + (2), re-baseline this scenario; expect score to rise meaningfully.

### `bad-command-crashloop-advocate` (70%, coverage) — **(B)**

Injector sets container args to an invalid flag, container exits immediately. Ground_truth: `application-error-uncaught-exception`.

Picks across 3 non-timeout runs:

| Pick | Score | Prose says |
|---|---|---|
| `deployment-rollout-failure` | 0.70 | "corrupted with a broken specification: the image was set to busybox:1.37 with command args containing an invalid flag" |
| `deployment-rollout-failure` | 0.70 | "args field was corrupted... container to exit immediately" |
| `deployment-rollout-failure` | 0.70 | "broken specification... pods exit immediately and fail readiness probes" |

Observations:
- **(B) Vocabulary ambiguity, crisp.** All three prose diagnoses identify the bad args as the cause. All three pick the effect category (`deployment-rollout-failure`) rather than the cause category (`application-error-uncaught-exception`).
- The vocab descriptions both apply: `application-error-uncaught-exception` says "bad command" explicitly; `deployment-rollout-failure` says "new pods crashloop." Both are textually correct.
- Cross-scenario inconsistency: `env-var-missing-advocate` has the same mechanism (app exits due to bad input) but a different ground_truth. Authoring should be coherent.

Recommendation:
1. Add `deployment-rollout-failure` as an accepted `secondary_categories` entry in the scenario YAML.
2. Reconcile ground_truth with `env-var-missing-advocate` (per that section's rec #1).

## Bucket summary

| Bucket | Scenarios | Prescription |
|---|---|---|
| (A) Reasoning failure | env-var-missing (partial), oom-advocate-api-k8s-only (partial) | Playbook authoring + fixture-visibility context. Week-5 candidates. |
| (B) Vocabulary ambiguity | liveness-probe (full), secret-missing-key (partial), bad-command-crashloop (full) | Partial-credit scoring via co-occurring categories. Scoring-layer fix. |
| (C) Ground-truth / fixture miscoding | env-var-missing, oom-advocate-api-k8s-only | Scenario-YAML + fixture improvements. |

**No scenario is purely (A).** Every sub-threshold anchor has either (B) or (C) contributing to the low score. The capability-gap-to-threshold delta is smaller than the naïve "5/10 pass" number suggests.

## Implications for the plan

1. **Do not expand to 15 anchors yet.** First land the (B) scoring fix — adding co-occurring-category partial credit — and the (C) ground-truth/fixture corrections. Re-baseline the 10 existing anchors. The 5/10-pass floor likely rises to 7–8/10 without any Emily capability changes.

2. **Playbook candidates** (Week 5) are narrower than expected: mostly the env-var-missing reasoning gap (once its ground_truth is corrected) and the oom-k8s fixture-confusion behavior (once fixture-reset and context docs are in).

3. **Vocabulary curation is a first-class maintenance task.** The `deployment-rollout-failure` category description overlaps meaningfully with `application-error-uncaught-exception` and `probe-misconfigured`. Either narrow its description or formalize the overlap via secondary-category credit.

## Next steps (ordered)

1. Implement co-occurring-category partial credit in `scoreDiagnose` (Step 2 of the external-feedback plan).
2. Update the three scenarios' ground_truth / secondary_categories (this report's recs).
3. Harden fixture reset in scenario-run.sh.
4. Add fixture-documentation section to `context/cluster.md`.
5. Re-baseline the 10 anchors at 3 reps each.
6. Re-run this audit; re-classify any remaining sub-threshold scenarios.
