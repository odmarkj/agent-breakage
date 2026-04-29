#!/usr/bin/env bash
#
# Phase 0 Stream B: n=40 re-runs to tighten underpowered findings.
#
# 2 scenarios × 2 arms × 40 reps = 160 runs.
# Scenarios:
#   1. cpu-limit-throttling-advocate (was t=1.82 just under significance at n=20)
#   2. replicas-zero-advocate (the before/after corpus-seed flip is the most
#      publishable narrative arc; was Δ=−0.31 at n=3 before seeding, +0.10 after)
#
# Same harness pattern as density-sweep.sh: per-cell runner restart, manifest
# CSV recording per-rep score + postmortem id.
#
# Usage:
#   bash breakage/scripts/n40-rerun.sh
#   REPS=10 bash breakage/scripts/n40-rerun.sh   # smoke test
#
# OPERATOR_MODEL defaults to claude-sonnet-4-6 (matches Stream A).

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

REPS="${REPS:-40}"
SCENARIOS="${SCENARIOS:-cpu-limit-throttling-advocate replicas-zero-advocate}"
OPERATOR_MODEL="${OPERATOR_MODEL:-claude-sonnet-4-6}"
ROOT_ENV="${ROOT_ENV:-$REPO_DIR/.env}"
LOG=/tmp/n40-rerun.log
MANIFEST=/tmp/n40-rerun-manifest.csv

: > "$LOG"
echo "scenario,arm,rep,postmortem_id,score,started_at" > "$MANIFEST"

echo "[n40-rerun] config:" >> "$LOG"
echo "  REPS=$REPS" >> "$LOG"
echo "  SCENARIOS=$SCENARIOS" >> "$LOG"
echo "  OPERATOR_MODEL=$OPERATOR_MODEL" >> "$LOG"
echo "[n40-rerun] started $(date -Iseconds)" >> "$LOG"

restart_runner() {
  local arm=$1
  pkill -9 -f 'src/runner/index.ts' 2>/dev/null || true
  sleep 3
  set -a; source "$ROOT_ENV"; set +a
  local KC
  KC="$(k3d kubeconfig write scenarios)"

  local env_args=(
    BREAKAGE_KUBECONFIG="$KC"
    BREAKAGE_DATABASE_URL='postgresql://breakage:breakage-changeme@127.0.0.1:5432/breakage'
    BREAKAGE_PORT=8088
    BREAKAGE_RETRIEVAL_MAX_DISTANCE=0.40
  )
  if [[ "$arm" == "control" ]]; then
    env_args+=(BREAKAGE_EMBEDDER=deterministic)
  fi

  echo "[n40-rerun] restarting runner: arm=$arm" >> "$LOG"
  env "${env_args[@]}" ./node_modules/.bin/tsx src/runner/index.ts \
    > /tmp/runner.log 2>&1 &
  disown

  local i
  for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:8088/health >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

ensure_synth() {
  if curl -sf http://127.0.0.1:8089/health >/dev/null 2>&1; then return 0; fi
  SYNTH_APPROVER_PORT=8089 SYNTH_APPROVER_DELAY_MIN_MS=300 \
    SYNTH_APPROVER_DELAY_MAX_MS=800 SYNTH_APPROVER_DENY_RATE=0 \
    ./node_modules/.bin/tsx src/synthetic-approver/index.ts > /tmp/synth.log 2>&1 &
  disown
  sleep 3
}

run_cell() {
  local scenario=$1 arm=$2
  echo "" >> "$LOG"
  echo "=== CELL scenario=$scenario arm=$arm reps=$REPS ===" >> "$LOG"
  if ! restart_runner "$arm"; then return 1; fi
  ensure_synth

  local r
  for r in $(seq 1 "$REPS"); do
    local started_at
    started_at=$(date -Iseconds)
    echo "" >> "$LOG"
    echo "--- $scenario arm=$arm rep=$r/$REPS — $(date +%H:%M:%S) ---" >> "$LOG"
    OPERATOR_MODEL="$OPERATOR_MODEL" \
      ./scripts/scenario-run.sh "$scenario" >> "$LOG" 2>&1 \
      || echo "[n40-rerun] scenario-run exit=$?" >> "$LOG"

    local pm_row
    pm_row=$(PGPASSWORD=breakage-changeme psql -h 127.0.0.1 -U breakage -d breakage -tA -c "
      SELECT id, COALESCE((run_metadata->'score'->>'total')::float::text, '')
      FROM postmortems
      WHERE source='scenario' AND scenario_id='$scenario'
        AND created_at >= '$started_at'
      ORDER BY created_at DESC LIMIT 1
    " 2>/dev/null)
    local pm_id pm_score
    pm_id="$(echo "$pm_row" | cut -d'|' -f1)"
    pm_score="$(echo "$pm_row" | cut -d'|' -f2)"
    echo "$scenario,$arm,$r,$pm_id,$pm_score,$started_at" >> "$MANIFEST"
  done
}

ARMS="tei control"
for scenario in $SCENARIOS; do
  for arm in $ARMS; do
    run_cell "$scenario" "$arm"
  done
done

echo "" >> "$LOG"
echo "[n40-rerun] finished $(date -Iseconds)" >> "$LOG"

BREAKAGE_DATABASE_URL='postgresql://breakage:breakage-changeme@127.0.0.1:5432/breakage' \
  ./node_modules/.bin/tsx src/scorecard/report.ts >> "$LOG" 2>&1
echo "[n40-rerun] scorecard written" >> "$LOG"
echo "[n40-rerun] manifest at $MANIFEST" >> "$LOG"
