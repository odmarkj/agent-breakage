#!/usr/bin/env bash
#
# Bring OpenTelemetry Demo up/down in the k3d-scenarios cluster as a
# scenario target application.
#
# OTel Demo is ~28 pods + Kafka + Postgres + OpenSearch — expensive to
# boot (3-5 min) but provides realistic multi-service traffic via
# Locust and 15 feature flags for failure injection via flagd.
#
# Kept as an ON-DEMAND target, not a permanently-running service.
# Bring up at the start of a test session; tear down when done.
#
# Usage:
#   ./scripts/target-otel-demo.sh up       # bring up (idempotent)
#   ./scripts/target-otel-demo.sh down     # tear down
#   ./scripts/target-otel-demo.sh reset    # down + up
#   ./scripts/target-otel-demo.sh status   # pods + traffic rate
#
# Environment knobs:
#   KUBECTL_CONTEXT    default: k3d-scenarios
#   OTEL_NAMESPACE     default: otel-demo
#   OTEL_CHART_VERSION default: 0.40.7

set -euo pipefail

CTX="${KUBECTL_CONTEXT:-k3d-scenarios}"
NS="${OTEL_NAMESPACE:-otel-demo}"
VER="${OTEL_CHART_VERSION:-0.40.7}"

up() {
  echo "[otel-demo] ensuring helm repo..."
  helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts >/dev/null 2>&1 || true
  helm repo update open-telemetry >/dev/null

  if ! kubectl --context="$CTX" get ns "$NS" >/dev/null 2>&1; then
    kubectl --context="$CTX" create ns "$NS"
  fi

  echo "[otel-demo] installing chart v${VER} into ns/$NS (this takes 3-5 min)..."
  if ! helm --kube-context="$CTX" status otel-demo -n "$NS" >/dev/null 2>&1; then
    helm --kube-context="$CTX" install otel-demo \
      open-telemetry/opentelemetry-demo \
      -n "$NS" \
      --version "$VER" \
      --wait --timeout 10m || true
  else
    echo "[otel-demo] already installed, skipping helm install"
  fi

  echo "[otel-demo] pre-pulling & importing flaky registry images (quay.io sometimes 502s)..."
  ensure_imported prom/prometheus:v3.9.0 quay.io/prometheus/prometheus:v3.9.0 || true
  ensure_imported kiwigrid/k8s-sidecar:2.2.1 quay.io/kiwigrid/k8s-sidecar:2.2.1 || true

  echo "[otel-demo] restarting any pods still in image-pull backoff..."
  kubectl --context="$CTX" -n "$NS" get pods --no-headers 2>/dev/null \
    | awk '$3 ~ /ImagePullBackOff|ErrImagePull/ { print $1 }' \
    | xargs -r kubectl --context="$CTX" -n "$NS" delete pod --ignore-not-found

  echo "[otel-demo] waiting for all pods ready..."
  local deadline=$(( $(date +%s) + 300 ))
  until [ "$(kubectl --context="$CTX" -n "$NS" get pods --no-headers 2>/dev/null \
               | awk '{print $2}' \
               | grep -cv '^1/1$\|^2/2$\|^3/3$\|^4/4$')" -eq 0 ]; do
    if [ "$(date +%s)" -gt "$deadline" ]; then
      echo "[otel-demo] timed out waiting for pods; current state:"
      kubectl --context="$CTX" -n "$NS" get pods
      return 1
    fi
    sleep 5
  done
  echo "[otel-demo] all pods ready"
  status
}

down() {
  echo "[otel-demo] tearing down..."
  helm --kube-context="$CTX" uninstall otel-demo -n "$NS" 2>/dev/null || true
  kubectl --context="$CTX" delete ns "$NS" --ignore-not-found --wait=true
  echo "[otel-demo] torn down"
}

reset() {
  down
  up
}

status() {
  if ! kubectl --context="$CTX" get ns "$NS" >/dev/null 2>&1; then
    echo "[otel-demo] not deployed (ns/$NS does not exist)"
    return 0
  fi
  echo "[otel-demo] pod phase summary:"
  kubectl --context="$CTX" -n "$NS" get pods --no-headers 2>/dev/null \
    | awk '{print $3}' | sort | uniq -c
  echo ""
  echo "[otel-demo] endpoints:"
  echo "  frontend-proxy    kubectl -n $NS port-forward svc/frontend-proxy 8080:8080"
  echo "  locust UI         kubectl -n $NS port-forward svc/load-generator 8089:8089"
  echo "  prometheus        kubectl -n $NS port-forward svc/prometheus 9090:9090"
  echo "  grafana           kubectl -n $NS port-forward svc/grafana 3000:80"
  echo "  flagd (HTTP)      kubectl -n $NS port-forward svc/flagd 8013:8013"
}

# ── helper: tag local image under the alias the cluster expects ─────

ensure_imported() {
  local local_ref="$1"
  local alias_ref="$2"
  local server_node="k3d-${CTX#k3d-}-server-0"
  local agent_node="k3d-${CTX#k3d-}-agent-0"

  # Skip if both nodes already have it.
  if docker exec "$server_node" crictl images 2>/dev/null | grep -q "$alias_ref" \
     && docker exec "$agent_node"  crictl images 2>/dev/null | grep -q "$alias_ref"; then
    return 0
  fi

  docker pull "$local_ref" >/dev/null 2>&1 || true

  local tar=/tmp/"${local_ref//[:\/]/-}.tar"
  docker save --platform "linux/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" \
    "$local_ref" -o "$tar" >/dev/null 2>&1

  for node in "$server_node" "$agent_node"; do
    docker cp "$tar" "$node":/tmp/img.tar >/dev/null
    docker exec "$node" ctr -n k8s.io images import /tmp/img.tar >/dev/null 2>&1 || true
    docker exec "$node" ctr -n k8s.io images tag "docker.io/$local_ref" "$alias_ref" 2>/dev/null || true
  done
  rm -f "$tar"
}

# ── entry point ─────────────────────────────────────────────────────

cmd="${1:-status}"
case "$cmd" in
  up)     up ;;
  down)   down ;;
  reset)  reset ;;
  status) status ;;
  *)
    echo "usage: $0 {up|down|reset|status}" >&2
    exit 2
    ;;
esac
