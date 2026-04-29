#!/usr/bin/env bash
# Start the k3s operator with port-forwarded postgres.
# Idempotent — safe to call multiple times.

set -euo pipefail

# Resolve kubeconfig: default to the repo-checked-in one, but let the caller override.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export KUBECONFIG="${KUBECONFIG:-$REPO_ROOT/infra/kubeconfig}"
if [ ! -f "$KUBECONFIG" ]; then
  echo "ERROR: kubeconfig not found at $KUBECONFIG" >&2
  exit 1
fi
echo "Using KUBECONFIG=$KUBECONFIG"

# Kill stale processes (exclude this script's PID)
pgrep -f 'port-forward.*postgres' | grep -v $$ | xargs -r kill 2>/dev/null || true
pgrep -f 'tsx watch.*server.ts' | grep -v $$ | xargs -r kill 2>/dev/null || true
sleep 1

# Start postgres port-forward (use 25432 to avoid conflict with local postgres on 5432)
kubectl port-forward -n platform service/postgres-rw 25432:5432 > /tmp/pf-postgres.log 2>&1 &
sleep 3

# Source env and start operator
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a && source "${ROOT_ENV:-$SCRIPT_DIR/../.env}" && set +a
cd "$SCRIPT_DIR"
DATABASE_URL='postgresql://operator_user:operator-changeme@localhost:25432/k3s_operator' \
ENABLE_WATCHERS=false \
nohup npx tsx watch src/server.ts > /tmp/k3s-operator.log 2>&1 &

# Wait for operator to be ready
for i in $(seq 1 10); do
  if curl -s http://localhost:8080/healthz >/dev/null 2>&1; then
    echo "Operator started successfully"
    exit 0
  fi
  sleep 1
done
echo "Operator started (health check pending)"
