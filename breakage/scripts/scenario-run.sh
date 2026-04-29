#!/usr/bin/env bash
#
# Orchestrates a complete scenario run against real Emily:
#
#   1. Ensures the runner is up (starts it if needed)
#   2. Starts the synthetic approver on :8089 (auto-approves all
#      tier-3 tool calls with a configurable deny rate)
#   3. Resets the prod-advocate fixture
#   4. Invokes drive-emily.ts with the scenario
#   5. Tears down the synthetic approver when done
#
# Usage:
#   ./scripts/scenario-run.sh <scenario-id>
#   DENY_RATE=0.2 ./scripts/scenario-run.sh secret-missing-key-advocate
#
# The runner + fixture are left up between runs. The synthetic
# approver is spun up per-invocation so deny-rate changes take
# effect.

set -euo pipefail

SCENARIO_ID="${1:-oom-advocate-api-k8s-only}"
DENY_RATE="${DENY_RATE:-0}"
ROOT_ENV="${ROOT_ENV:-$REPO_DIR/.env}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$REPO_DIR"

# ── Runner ──────────────────────────────────────────────────────────
if ! curl -sf http://127.0.0.1:8088/health >/dev/null 2>&1; then
  echo "[scenario-run] starting runner on :8088…"
  set -a; source "$ROOT_ENV"; set +a
  KC="$(k3d kubeconfig write scenarios)"
  BREAKAGE_KUBECONFIG="$KC" \
    BREAKAGE_DATABASE_URL="postgresql://breakage:breakage-changeme@127.0.0.1:5432/breakage" \
    BREAKAGE_PORT=8088 \
    nohup ./node_modules/.bin/tsx src/runner/index.ts > /tmp/runner.log 2>&1 &
  disown
  until curl -sf http://127.0.0.1:8088/health >/dev/null 2>&1; do sleep 1; done
  echo "[scenario-run] runner up"
fi

# ── Synthetic approver ──────────────────────────────────────────────
echo "[scenario-run] starting synthetic approver on :8089 (deny_rate=$DENY_RATE)…"
pkill -f "src/synthetic-approver/index.ts" 2>/dev/null || true
sleep 0.5
SYNTH_APPROVER_PORT=8089 \
  SYNTH_APPROVER_DELAY_MIN_MS=300 \
  SYNTH_APPROVER_DELAY_MAX_MS=800 \
  SYNTH_APPROVER_DENY_RATE="$DENY_RATE" \
  nohup ./node_modules/.bin/tsx src/synthetic-approver/index.ts > /tmp/synth.log 2>&1 &
SYNTH_PID=$!
disown
until curl -sf http://127.0.0.1:8089/health >/dev/null 2>&1; do sleep 0.25; done
echo "[scenario-run] synth approver up (pid=$SYNTH_PID)"

cleanup() {
  echo ""
  echo "[scenario-run] tearing down synthetic approver…"
  kill "$SYNTH_PID" 2>/dev/null || true
}
trap cleanup EXIT

# ── Fixture ─────────────────────────────────────────────────────────
./scripts/target-advocate.sh reset >/dev/null 2>&1
echo "[scenario-run] fixture ready"

# ── Drive ───────────────────────────────────────────────────────────
echo "[scenario-run] driving Emily against scenario: $SCENARIO_ID"
echo ""
set -a; source "$ROOT_ENV"; set +a
KC="$(k3d kubeconfig write scenarios)"
BREAKAGE_RUNNER_URL=http://127.0.0.1:8088 \
  SYNTH_APPROVER_URL=http://127.0.0.1:8089 \
  KUBECONFIG="$KC" \
  K3S_KUBECONFIG="$KC" \
  DATABASE_URL=postgresql://operator_test:operator-test-changeme@127.0.0.1:5432/operator_test \
  OPERATOR_MODEL="${OPERATOR_MODEL:-claude-haiku-4-5-20251001}" \
  ./node_modules/.bin/tsx scripts/drive-emily.ts "$SCENARIO_ID"
