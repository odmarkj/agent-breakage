#!/usr/bin/env bash
#
# Phase 0 corpus-density sweep harness.
#
# Cells: 3 scenarios × 3 density tiers × 2 arms × N reps (default 20).
# Density tiers control retrieval pool size via BREAKAGE_RETRIEVAL_POOL_CAP:
#   LOW=5, MEDIUM=15, HIGH=unset (full corpus).
# Arms:
#   TEI       — bge-m3 via shared embeddings service
#   CONTROL   — BREAKAGE_EMBEDDER=deterministic (semantically random)
#
# After each rep the harness records (scenario, density, arm, rep, postmortem_id,
# score) to /tmp/density-sweep-manifest.csv for downstream analysis.
#
# Restart cost: ~7 sec per runner restart; we batch all reps within a cell
# under one runner config to minimize restarts (18 restarts total for full sweep).
#
# Usage:
#   bash breakage/scripts/density-sweep.sh           # run full sweep
#   REPS=2 bash breakage/scripts/density-sweep.sh    # smoke test (2 reps/cell)
#   SCENARIOS="cpu-limit-throttling-advocate" bash breakage/scripts/density-sweep.sh
#                                                     # subset

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# ── config ──────────────────────────────────────────────────────────
REPS="${REPS:-20}"
SCENARIOS="${SCENARIOS:-secret-missing-key-advocate liveness-probe-always-fails-advocate cpu-limit-throttling-advocate}"
OPERATOR_MODEL="${OPERATOR_MODEL:-claude-sonnet-4-6}"
ROOT_ENV="${ROOT_ENV:-$REPO_DIR/.env}"
LOG=/tmp/density-sweep.log
MANIFEST=/tmp/density-sweep-manifest.csv

: > "$LOG"
echo "scenario,density,arm,rep,postmortem_id,score,started_at" > "$MANIFEST"

echo "[density-sweep] config:" >> "$LOG"
echo "  REPS=$REPS" >> "$LOG"
echo "  SCENARIOS=$SCENARIOS" >> "$LOG"
echo "  OPERATOR_MODEL=$OPERATOR_MODEL" >> "$LOG"
echo "[density-sweep] started $(date -Iseconds)" >> "$LOG"

# ── runner restart helper ───────────────────────────────────────────
restart_runner() {
  local arm=$1 density=$2  # arm: tei|control; density: 5|15|full
  pkill -9 -f 'src/runner/index.ts' 2>/dev/null || true
  sleep 3

  set -a; source "$ROOT_ENV"; set +a
  local KC
  KC="$(k3d kubeconfig write scenarios)"

  local env_args=(
    BREAKAGE_KUBECONFIG="$KC"
    BREAKAGE_DATABASE_URL='postgresql://breakage:breakage-changeme@127.0.0.1:5432/breakage'
    BREAKAGE_PORT=8088
    BREAKAGE_RETRIEVAL_MAX_DISTANCE=0.40  # consistent with falsification test
  )
  if [[ "$arm" == "control" ]]; then
    env_args+=(BREAKAGE_EMBEDDER=deterministic)
  fi
  if [[ "$density" != "full" ]]; then
    env_args+=("BREAKAGE_RETRIEVAL_POOL_CAP=$density")
  fi

  echo "[density-sweep] restarting runner: arm=$arm density=$density" >> "$LOG"
  env "${env_args[@]}" ./node_modules/.bin/tsx src/runner/index.ts \
    > /tmp/runner.log 2>&1 &
  disown

  # Wait for runner readiness
  local i
  for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:8088/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "[density-sweep] runner failed to come up" >> "$LOG"
  return 1
}

# ── synth approver (start once, leave running) ──────────────────────
ensure_synth() {
  if curl -sf http://127.0.0.1:8089/health >/dev/null 2>&1; then return 0; fi
  echo "[density-sweep] starting synth approver" >> "$LOG"
  SYNTH_APPROVER_PORT=8089 SYNTH_APPROVER_DELAY_MIN_MS=300 \
    SYNTH_APPROVER_DELAY_MAX_MS=800 SYNTH_APPROVER_DENY_RATE=0 \
    ./node_modules/.bin/tsx src/synthetic-approver/index.ts > /tmp/synth.log 2>&1 &
  disown
  sleep 3
}

# ── per-cell run loop ───────────────────────────────────────────────
run_cell() {
  local scenario=$1 density=$2 arm=$3
  echo "" >> "$LOG"
  echo "=== CELL scenario=$scenario density=$density arm=$arm reps=$REPS ===" >> "$LOG"
  if ! restart_runner "$arm" "$density"; then return 1; fi
  ensure_synth

  local r
  for r in $(seq 1 "$REPS"); do
    local started_at
    started_at=$(date -Iseconds)
    echo "" >> "$LOG"
    echo "--- $scenario density=$density arm=$arm rep=$r/$REPS — $(date +%H:%M:%S) ---" >> "$LOG"
    OPERATOR_MODEL="$OPERATOR_MODEL" \
      ./scripts/scenario-run.sh "$scenario" >> "$LOG" 2>&1 \
      || echo "[density-sweep] scenario-run exit=$?" >> "$LOG"

    # Identify the postmortem this run produced by scanning for the
    # most-recent row newer than `started_at`.
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
    echo "$scenario,$density,$arm,$r,$pm_id,$pm_score,$started_at" >> "$MANIFEST"
  done
}

# ── main ────────────────────────────────────────────────────────────
DENSITIES="5 15 full"
ARMS="tei control"

for scenario in $SCENARIOS; do
  for density in $DENSITIES; do
    for arm in $ARMS; do
      run_cell "$scenario" "$density" "$arm"
    done
  done
done

echo "" >> "$LOG"
echo "[density-sweep] finished $(date -Iseconds)" >> "$LOG"

# Auto-generate scorecard for the period
BREAKAGE_DATABASE_URL='postgresql://breakage:breakage-changeme@127.0.0.1:5432/breakage' \
  ./node_modules/.bin/tsx src/scorecard/report.ts >> "$LOG" 2>&1
echo "[density-sweep] scorecard written" >> "$LOG"
echo "[density-sweep] manifest at $MANIFEST" >> "$LOG"
