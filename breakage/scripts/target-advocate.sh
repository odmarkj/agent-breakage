#!/usr/bin/env bash
#
# Manage the prod-advocate fixture in the k3d-scenarios cluster.
# This is the single-service target that most anchor scenarios
# break. Unlike nginx (which ignores env vars), this fixture uses
# a small busybox container that validates required env vars at
# startup and fails loud when any is missing — so secret/env
# scenarios produce observable failure modes Emily can diagnose.
#
# Usage:
#   ./scripts/target-advocate.sh up       # create namespace + secret + deployment (idempotent)
#   ./scripts/target-advocate.sh down     # delete the namespace
#   ./scripts/target-advocate.sh reset    # down + up
#   ./scripts/target-advocate.sh status   # pod + secret state

set -euo pipefail

CTX="${KUBECTL_CONTEXT:-k3d-scenarios}"
NS="${ADVOCATE_NAMESPACE:-prod-advocate}"
DEPLOY_NAME="advocate-api"
SECRET_NAME="advocate-secrets"

up() {
  if ! kubectl --context="$CTX" get ns "$NS" >/dev/null 2>&1; then
    kubectl --context="$CTX" create ns "$NS"
  fi

  # Secret: contains the keys a real advocate-api would read on boot.
  # Idempotent via apply-from-stdin.
  kubectl --context="$CTX" -n "$NS" create secret generic "$SECRET_NAME" \
    --from-literal=DATABASE_URL='postgresql://advocate:test-password@postgres-rw.platform.svc.cluster.local:5432/advocate' \
    --from-literal=SESSION_SECRET='test-session-secret-48-chars-long-for-realism-ok' \
    --from-literal=ANTHROPIC_API_KEY='sk-test-placeholder-not-used-by-fixture' \
    --dry-run=client -o yaml | kubectl --context="$CTX" apply -f - >/dev/null

  # Deployment: busybox that validates env vars at startup and
  # keeps a readiness file up-to-date. Fails pod readiness when
  # required vars are missing; detector condition
  # `readyReplicas == desiredReplicas` will fail until fixed.
  cat <<'YAML' | kubectl --context="$CTX" -n "$NS" apply -f - >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata:
  name: advocate-api
  labels: {app: advocate-api}
spec:
  replicas: 1
  # Recreate strategy: kill old pod before starting new. Required
  # for scenario realism — with RollingUpdate, the old pod stays
  # Ready with its cached env while a broken new pod flaps, and the
  # detector sees readyReplicas == desiredReplicas the whole time,
  # masking the failure. Production services should use RollingUpdate;
  # this fixture is optimized for observing injected breaks.
  strategy:
    type: Recreate
  selector:
    matchLabels: {app: advocate-api}
  template:
    metadata:
      labels: {app: advocate-api}
    spec:
      containers:
      - name: app
        image: busybox:1.37
        # Validate required env vars, then create the ready file
        # and keep it present. If any var is missing → fatal exit,
        # ReplicaSet loops. If SESSION_SECRET is empty → also fatal.
        # readiness probe checks for /tmp/ready.
        command: ["/bin/sh", "-c"]
        args:
        - |
          set -eu
          echo "[advocate-api] booting"
          : "${DATABASE_URL:?DATABASE_URL is required but missing}"
          : "${SESSION_SECRET:?SESSION_SECRET is required but missing}"
          : "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required but missing}"
          if [ -z "$SESSION_SECRET" ]; then
            echo "[advocate-api] SESSION_SECRET is empty" >&2
            exit 1
          fi
          touch /tmp/ready
          echo "[advocate-api] ready"
          # Minimal HTTP responder for probes. Uses busybox httpd with a tiny docroot.
          mkdir -p /www
          echo ok > /www/healthz
          exec httpd -f -p 8080 -h /www
        envFrom:
        - secretRef:
            name: advocate-secrets
        ports:
        - containerPort: 8080
        resources:
          requests: {memory: 16Mi}
          limits:   {memory: 256Mi}
        readinessProbe:
          httpGet: {path: /healthz, port: 8080}
          initialDelaySeconds: 2
          periodSeconds: 5
          failureThreshold: 3
        livenessProbe:
          httpGet: {path: /healthz, port: 8080}
          initialDelaySeconds: 10
          periodSeconds: 10
          failureThreshold: 3
YAML

  kubectl --context="$CTX" -n "$NS" rollout status deployment/$DEPLOY_NAME --timeout=60s >/dev/null
  echo "[target-advocate] up"
  status
}

down() {
  kubectl --context="$CTX" delete ns "$NS" --ignore-not-found --wait=true >/dev/null
  echo "[target-advocate] down"
}

reset() {
  down
  up
}

status() {
  if ! kubectl --context="$CTX" get ns "$NS" >/dev/null 2>&1; then
    echo "[target-advocate] not deployed"
    return 0
  fi
  echo "[target-advocate] namespace: $NS"
  kubectl --context="$CTX" -n "$NS" get deploy "$DEPLOY_NAME" -o wide 2>/dev/null | sed 's/^/  /'
  echo ""
  kubectl --context="$CTX" -n "$NS" get pods -l app=$DEPLOY_NAME 2>/dev/null | sed 's/^/  /'
  echo ""
  kubectl --context="$CTX" -n "$NS" get secret "$SECRET_NAME" -o jsonpath='{"  keys in advocate-secrets: "}{.data}{"\n"}' 2>/dev/null \
    | sed 's/,/\n                            /g; s/{/ [/; s/}/]/'
}

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
