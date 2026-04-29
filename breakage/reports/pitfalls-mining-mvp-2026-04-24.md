# Inverse-guardrail-mining MVP — 2026-04-24

Per plan §16 Week-4 cut. This is **Step 5** of the external-feedback-driven plan, adapted from "full §16 scope" to "MVP that validates the pipeline on the synthetic corpus before it's ever run on real production incidents."

## What shipped

`breakage/src/reports/pitfalls.ts` (already stubbed, completed today) + `npm run pitfalls`. Output: one `reports/pitfalls/<category>.md` per category with regressed-or-struggling incidents, plus `INDEX.md`.

Two data sources merged:
1. **Canonical**: `outcome = 'regressed'` — the plan-§16 signal.
2. **Secondary**: scenario postmortems scoring below `LOW_SCORE_THRESHOLD=0.5` — scenarios where Emily struggled even without detectors tripping `regressed_when`. Pragmatic amplification at a phase where `regressed_when` clauses are mostly empty in scenario YAMLs.

Two pattern-matching lenses:
1. **Sequence**: order-sensitive tool trajectory. Strict; misses under agent-reasoning variance.
2. **Tool-set**: sorted unique tool names. Coarser; surfaces "Emily used this mix of tools" signal.

`MIN_OCCURRENCES=2` threshold so single-run noise doesn't surface.

## First-run output

Against current corpus (240 total postmortems, 3 canonical regressed + 15 low-scoring scenario):

| Category | Regressed/struggling | Patterns surfaced |
|---|---|---|
| `configuration-error` | 2 | 1 (tool-set match) |
| `consumer-contract-violation` | 1 | 0 (single-row categories can't repeat) |
| `secret-content-mismatch` | 1 | 0 |
| `symptom-misdiagnosis` | 1 | 0 |

### What the `configuration-error` report reveals

The 2 pattern-matched runs are both `secret-missing-key-advocate` runs where Emily picked `configuration-error` (an out-of-vocab label) as her `primary_category`. Reading the diagnosis prose:

> "The advocate-api pods are in CrashLoopBackOff due to a missing SESSION_SECRET key in the advocate-secrets Secret."

Emily's REASONING was correct. She just picked the wrong category name. This is the exact same `secret-missing` vs `secret-content-mismatch` vocab ambiguity the 2026-04-23 anchor-fail audit identified.

**This is the mining pipeline working as intended.** Plan §16 says mining on synthetic data is meant to (a) surface real pitfalls AND (b) validate the pipeline. Here it's validating both: a real Emily pitfall (vocab-pick drift on secret scenarios) is surfaced by the mining query, with the exact action-tool-set that precedes it.

## What the MVP does NOT do

- **Does not auto-inject findings into Emily's context.** That's Phase 5+ per plan explicitly. Reports are human-reviewed.
- **Does not deduplicate the sequence-lens and tool-set-lens patterns** into a single ranked list. Both patterns are reported; the reviewer filters.
- **Does not classify patterns by severity.** A tool-set match at n=2 is treated the same as one at n=20. In practice the absolute count reflects severity because higher-count patterns mean more repeated failures.

## Verification against plan §16 goals

Plan §16 purpose statements:

> (a) surface real pitfalls in Emily's behavior early

✓ Surfaced the vocab-drift pitfall from the anchor-fail audit independently.

> (b) validate the mining pipeline on synthetic baseline data BEFORE it's ever run on real production incidents.

✓ Pipeline runs end-to-end, outputs per-category markdown, handles edge cases (empty actions_taken for timeout stubs, single-row categories).

## Running

```bash
cd breakage
npm run pitfalls     # writes to breakage/reports/pitfalls/
```

Idempotent. Safe to run on every new baseline; regenerates all reports each time.

## Next steps (Phase 1)

1. **When scenario authors add `regressed_when` clauses**, the canonical signal (outcome=regressed) will grow. The secondary low-score lens becomes less necessary but stays as safety net.
2. **Before Week 5 playbook-authoring decision**, re-run `npm run pitfalls` on the full baseline. Compare the patterns it surfaces to the anchor-fail audit's findings. If they agree, the audit was thorough; if mining finds additional patterns, those are the highest-priority playbook targets.
3. **Phase 5+**: optional — add automated reviewer-approved promotion path from `pitfalls/<category>.md` → `context/playbooks/<category>.yaml` `known_pitfalls` entries.
