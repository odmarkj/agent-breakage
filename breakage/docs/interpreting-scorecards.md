# Interpreting scorecards

A scorecard is the framework's primary output: a structured record of how the agent did on a set of scenarios. This document explains what the numbers mean, what specific gotchas to watch for, and how to translate scorecard observations into agent-quality decisions.

## Scorecard formats

Two artifacts get produced per `npm run scorecard`:

1. **Markdown** at `breakage/reports/scorecard-<timestamp>.md` (plus `scorecard-latest.md` symlink). Human-readable; per-scenario table sorted worst-first; per-category rollup; retrieval-impact section.
2. **The underlying postmortems table** in Postgres. The markdown is a view; the source-of-truth is in `postmortems` rows with their `run_metadata` JSONB column containing the `score` breakdown and `detector` observations.

For ad-hoc analysis you query the table directly. For comparison or sharing, the markdown is what you cite.

## The four axes

Every scenario run produces a `ScoreResult` with four axis components plus a total in `[0, 1]`. Defaults are documented in scenario YAMLs as `scorer.credits`:

| Axis | Default weight | What it measures |
|---|---|---|
| `detected` | 0.2 | Did the agent observe the problem within the time budget? In Phase 1 this is satisfied if `actions_taken.length > 0` — the agent made any tool call after injection. |
| `diagnosed` | 0.3 | Did the agent pick the correct `primary_category` and any correct `secondary_categories`? |
| `fixed` | 0.3 | Did `detector.fixed_when` conditions go true within the time budget? |
| `no_regressions` | 0.2 | Did `detector.regressed_when` stay false? Weighted by the maximum reversibility of the agent's actions when a regression *was* observed. |

Total = sum across axes, clamped `[0, 1]`. The framework uses partial credit deliberately — pass/fail would lose information about *which axis* the agent struggled with.

### `diagnosed` axis: primary + secondaries with near-miss credit

The scorer (`src/scorer/diagnose.ts`) computes diagnosis credit as:

- **Exact primary match**: 0.7 × axis weight.
- **Near-miss primary** (agent's primary in scenario's `secondary_categories`, or vice versa): 0.35 × axis weight.
- **No primary overlap**: 0 × axis weight.
- **Each correct secondary**: 0.1 × axis weight, capped at 0.3.

The near-miss path is critical and was added 2026-04-23 after an audit found that most sub-threshold scenarios were pulled down by effect-vs-cause vocabulary overlap. A liveness-probe scenario with `ground_truth.primary_category=probe-misconfigured` where the agent picked `deployment-rollout-failure` (the *effect*) used to score 0; with near-miss credit it scores 0.35 if the scenario YAML lists `deployment-rollout-failure` in `secondary_categories`. The agent's reasoning was correct — only the category-ranking was effect-layer instead of cause-layer.

Lookup `primaryNearMiss: true` in the postmortem's `run_metadata.score.axes.diagnosed.detail` to see when this fired.

### `no_regressions` axis: reversibility-weighted

When `regressed_when` does *not* trip, full credit. When it *does*, credit decays based on the *maximum reversibility* of any action the agent took:

```
earned = possible × max(0, 1 − maxReversibility × hadRegression)
```

Reversibility is per-tool, declared in `operator/src/tools/<tool>.ts`'s `reversibility` field. Scale:
- 0.0 — read-only (kubectl get, describe, logs).
- 0.3 — reversible-via-snapshot (kubectl scale, restart, single-resource patch). The speculative-exec controller catches and reverts.
- 0.7 — reversible-with-effort (kubectl exec into a container, code-fix).
- 1.0 — irreversible (Secret content writes, deletes).

A regression caused entirely by reversible tool calls (max=0.3) earns 0.7 of the `no_regressions` axis credit. A regression caused by an irreversible tool call (max=1.0) earns 0.

This is why anchor scenarios with empty `regressed_when: []` always award full `no_regressions` credit — there's nothing to trip. Authored regressions are scenario-level decisions, not framework defaults.

## `retrieval_used` is observed, not self-reported

The agent does not report which retrievals it used. The scorer infers it post-hoc by comparing the agent's tool-sequence to each retrieved postmortem's `actions_taken`. If the *containment similarity* exceeds threshold 0.5, that retrieval is marked "used."

Containment is asymmetric: `|retrieval_tools ∩ agent_tools| / |retrieval_tools|`. This measures whether the agent's tool sequence covers the retrieved postmortem's tool set. Asymmetric was chosen over Jaccard because Jaccard penalizes thorough investigation — agents that run extra read-only tools beyond a retrieved exemplar's actions get marked as not-using-retrieval under Jaccard, which inverts the desired incentive.

The pre-Phase-0 `retrieval_used` count was tracked under a Jaccard formula that systematically undercounted; rerun analyses use containment.

## `channel_disagreement`

When the agent emits hypotheses mid-investigation (via `emit_hypothesis`) and the *last* one disagrees with her final postmortem's `primary_category`, the run is flagged. This is a *disagreement signal*, not a penalty. Disagreement-flagged runs become training data for both:

1. The agent's future postmortems (recognize where reasoning shifted late).
2. The implicit-inference channel (where action sequences diverged from declared hypotheses).

Per the Phase-1 plan §4, channel disagreement is a *human review queue input*, not an automated correction.

Look for `channel_disagreement.flagged: true` in `run_metadata.score`.

## `framework-error` rows: filter these out

Some `postmortems` rows have `primary_category = framework-error`. These are scenarios where the framework itself failed (injector throw, detector crash, runner timeout) before the agent could meaningfully act. Always filter them out when judging agent capability. They show up in scorecards as 0% scenarios but they're not the agent's fault.

The orchestrator emits these via `synthesizeRunFailurePostmortem` to maintain the invariant "every `/run` call produces exactly one DB row." Without that invariant, scorecards undercount (silently dropped runs) instead of clearly attributing failures.

## Reading the scorecard markdown

A typical per-scenario row:

```
| Scenario | Category | Reps | Mean | Min | Max | Pass rate | Retrieval used | Last run |
| secret-missing-key-advocate | application-error-uncaught-exception | 28 | **64%** ✗ | 20% | 91% | 32% | 5/28 | 2026-04-22 22:33:48 |
```

What this is telling you:

- 28 reps total in the database for this scenario.
- Mean score 64% — below the 75% pass threshold (✗).
- Wide variance: 20% to 91%. Some reps fail nearly entirely; some fully succeed.
- 32% of reps cleared 75% individually (pass rate).
- 5 of 28 reps had `retrieval_used` populated (the scorer inferred at least one retrieval was used).

Note `Category` here is the *agent's* most-common pick across reps, not the ground_truth. When the most-common pick is wrong (e.g., `secret-missing-key-advocate` → `application-error-uncaught-exception` instead of `secret-content-mismatch`), it's a strong vocab-drift signal.

## Per-category rollups

The `Per-category rollup` section groups scenarios by *ground_truth* `primary_category` (not by agent pick). Mean across all reps in scenarios in that category. This surfaces which categories the agent is weakest at, holding scenario count constant.

## Retrieval impact

The `Retrieval impact` section reports a *correlation*, not a *causal* effect:

> - With-retrieval runs: 25 runs, mean 84.0%
> - Without-retrieval runs: 40 runs, mean 65.6%
> - Delta: 18.4%

This is the **action-pattern-match correlation** number. It tells you "in runs where the scorer observed that the agent's actions matched a retrieved postmortem's pattern, the agent scored higher on average." It does *not* tell you "retrieval caused the higher score" — runs where the agent is on track also produce action sequences that look like past successes regardless of whether retrieval drove them. Selection bias.

To get the causal answer, run the controlled comparison via `breakage/scripts/falsify-tei.sh` and `falsify-control.sh` (TEI vs deterministic embedder, n=20+ per arm, same scenarios). The current published number from that experiment is +0.039 pooled (1 of 3 scenarios significant at p<0.05). Cite that, not the observational delta — see [`breakage/reports/falsification-test-2026-04-24.md`](../reports/falsification-test-2026-04-24.md) for the full result.

## Common gotchas

**Timeout-stub postmortems.** When the agent doesn't post a postmortem within the scenario's time budget, the orchestrator synthesizes a stub with `final_diagnosis = "[timeout] Emily did not submit..."` and `primary_category = application-error-uncaught-exception`. These score `detected=0.2 + others=0`, so the scenario lands at exactly 0.2 (or higher if `regressed_when` was empty so `no_regressions` paid full). If a scenario's mean is exactly 0.5 across many reps and they all have `actions_taken=[]`, that's the stub pattern — increase `time_budget_s` or check whether the agent is hitting tool-round limits.

**Reading per-scenario means vs pooled.** The pooled mean across scenarios is *not* a pooled mean across reps — it's a mean of means. Two scenarios at 50% and 90% with very different rep counts produce a different number under per-scenario averaging vs per-rep averaging. The scorecard markdown reports both, but be explicit about which one you're citing.

**Pre-2026-04-23 rows are unreliable.** Ground-truth corrections, vocab broadening, and the near-miss-credit mechanism all landed in the 2026-04-22-to-2026-04-23 window. Rows from before that period are scored against an older rule set. Filter by `created_at >= '2026-04-23T20:35:00Z'` for analyses that depend on current scoring.

**Pre-HNSW-migration rows are also unreliable.** Migration 004 (HNSW index) landed 2026-04-24. Before that, `ivfflat` returned 0–3 rows sporadically from any retrieval, meaning every "retrieval-on" run before that date was actually running against degraded retrieval. Reports written before 2026-04-24 (notably `retrieval-delta-controlled-2026-04-23.md`) are explicitly superseded.

**Run-id × scenario-id collisions.** The `id` of every postmortem is `<scenario_id>-<run-uuid>`. The `scenario_id` column is what you `GROUP BY` for per-scenario analysis. Don't confuse the two.

**Scenarios with `status: regression-watch` are excluded from baselines.** Those are typically scenarios with infra dependencies (Prometheus) that aren't present in default reproductions. The default scorecard run still includes their historical rows; filter by `status` if you want to compare against the active scorecard surface only.

## Programmatic access

For analyses beyond what the markdown reports, query the table:

```sql
-- Per-scenario mean + std at >=20 reps, post-near-miss-credit landing
SELECT
  scenario_id,
  count(*) AS n,
  round(avg((run_metadata->'score'->>'total')::float)::numeric, 3) AS mean,
  round(stddev((run_metadata->'score'->>'total')::float)::numeric, 3) AS sd
FROM postmortems
WHERE source = 'scenario'
  AND primary_category != 'framework-error'
  AND created_at >= '2026-04-23T20:35:00Z'
GROUP BY scenario_id
HAVING count(*) >= 20
ORDER BY mean DESC;

-- Per-arm comparison for one scenario
SELECT
  CASE
    WHEN created_at < '<TEI_arm_end>' AND created_at >= '<TEI_arm_start>' THEN 'tei'
    WHEN created_at >= '<control_arm_start>' THEN 'control'
  END AS arm,
  count(*) AS n,
  round(avg((run_metadata->'score'->>'total')::float)::numeric, 3) AS mean
FROM postmortems
WHERE source = 'scenario'
  AND scenario_id = '<scenario>'
  AND created_at >= '<TEI_arm_start>'
GROUP BY arm;
```

Patterns from prior reports' SQL plus the small Python t-test script in their analysis sections (`statistics.mean`, `statistics.stdev`, manual Welch's t-test) cover most analysis needs without bringing scipy in.

## What scorecards can't tell you

The framework measures *agent-on-scenario* behavior. It does not measure:

- Whether the scenarios themselves are representative of real-world incidents (you have to author from real sources to claim that).
- Whether the agent's runtime outside scenarios (real production, idle watching, model-tier choice) is well-tuned (separate measurement system).
- Whether the corpus is large enough to compound (use the corpus-density sweep experiment for that).

When citing a scorecard externally, the headline number that matters is per-scenario mean ± std at the target rep count, not pooled. Pooled means hide which scenarios drive them.
