#!/usr/bin/env bash
#
# Apply the Emily-in-k3d-scenarios deployment.
#
# Builds the Secret + ConfigMap from the local environment, then
# applies all manifests in breakage/deploy/operator/.
#
# Prereqs:
#   - k3d-scenarios cluster exists
#   - ANTHROPIC_API_KEY is set in env (or sourced from repo root .env)
#   - Image k3s-operator:scenarios has been built + imported
#   - Native Postgres on VM has an operator_test database

set -euo pipefail

CTX="${KUBECTL_CONTEXT:-k3d-scenarios}"
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/../../../" && pwd)"
CONTEXT_DIR="$REPO_ROOT/context"

# Try multiple .env locations: worktree root, then main repo. The
# worktree may not have a .env since it's a scratch branch, so
# fall through to the main repo's .env which holds ANTHROPIC_API_KEY.
for ENV_FILE in "$REPO_ROOT/.env"; do
  if [ -f "$ENV_FILE" ]; then
    set -a; source "$ENV_FILE"; set +a
    break
  fi
done

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "error: ANTHROPIC_API_KEY not set (expected in env or $ENV_FILE)" >&2
  exit 2
fi

echo "[operator-deploy] applying namespace + rbac…"
kubectl --context="$CTX" apply -f "$DEPLOY_DIR/namespace.yaml" >/dev/null
kubectl --context="$CTX" apply -f "$DEPLOY_DIR/rbac.yaml" >/dev/null

echo "[operator-deploy] creating/updating operator-secrets…"
kubectl --context="$CTX" -n operator create secret generic operator-secrets \
  --from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  --dry-run=client -o yaml \
  | kubectl --context="$CTX" apply -f - >/dev/null

echo "[operator-deploy] creating/updating operator-context from $CONTEXT_DIR…"
# Pack the cluster context files + playbooks subdirectory. kubectl
# `--from-file=<dir>` flattens nested files into the ConfigMap's
# keys — we want playbooks/*.yaml accessible at /app/context/playbooks,
# so we include those with a key prefix.
TMP_CM=$(mktemp)
trap "rm -f $TMP_CM" EXIT

{
  echo "apiVersion: v1"
  echo "kind: ConfigMap"
  echo "metadata:"
  echo "  name: operator-context"
  echo "  namespace: operator"
  echo "data:"
  # Top-level context files (cluster.md, services.md, sops.md, mutation-safety.md, etc.)
  for f in "$CONTEXT_DIR"/*.md; do
    [ -e "$f" ] || continue
    key="$(basename "$f")"
    echo "  $key: |"
    sed 's/^/    /' "$f"
  done
  # Ship the root-cause vocabulary so Emily renders it in her system
  # prompt. Without the vocab she invents labels like
  # "configuration-error" that don't match ground_truth categories
  # and score 0 on the diagnosed axis even when her prose is right.
  VOCAB_FILE="$REPO_ROOT/breakage/vocab/root-cause-categories.yaml"
  if [ -f "$VOCAB_FILE" ]; then
    echo "  root-cause-categories.yaml: |"
    sed 's/^/    /' "$VOCAB_FILE"
  fi
} > "$TMP_CM"
kubectl --context="$CTX" apply -f "$TMP_CM" >/dev/null

# Playbooks: separate ConfigMap mounted under /app/context/playbooks.
# Using --from-file=<dir> to get each .yaml as its own key.
if [ -d "$CONTEXT_DIR/playbooks" ]; then
  echo "[operator-deploy] creating/updating operator-playbooks from $CONTEXT_DIR/playbooks…"
  kubectl --context="$CTX" -n operator create configmap operator-playbooks \
    --from-file="$CONTEXT_DIR/playbooks" \
    --dry-run=client -o yaml \
    | kubectl --context="$CTX" apply -f - >/dev/null
fi

echo "[operator-deploy] applying deployment…"
kubectl --context="$CTX" apply -f "$DEPLOY_DIR/deployment.yaml" >/dev/null

echo "[operator-deploy] waiting for rollout…"
kubectl --context="$CTX" -n operator rollout status deploy/k3s-operator --timeout=180s

echo ""
echo "[operator-deploy] done. Status:"
kubectl --context="$CTX" -n operator get deploy,pods,svc
echo ""
echo "To reach Emily's HTTP API:"
echo "  kubectl --context=$CTX -n operator port-forward svc/k3s-operator 8080:80"
