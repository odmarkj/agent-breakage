#!/usr/bin/env bash
#
# Sync Emily's `operator-context` ConfigMap + vocab to one or more
# clusters. Runs against prod (`--prod`), k3d-scenarios (`--scenarios`),
# or both (`--all`). Rollout-restarts the k3s-operator deployment so
# the new ConfigMap content is picked up immediately.
#
# Scope:
#   - All *.md under context/
#   - breakage/vocab/root-cause-categories.yaml (rendered into prompt)
#
# Out of scope (image-level, requires release cycle):
#   - operator/src/** code changes
#   - operator/src/breakage/** (retrieval client)
#   - operator/src/tools/hypothesis.ts, postmortem.ts
#   - prompt-sections.ts wiring
#
# For image updates, commit to main, let CI rebuild
# `ghcr.io/odmarkj/k8s-operator:latest`, then rolling-restart prod.
#
# Usage:
#   bash operator/scripts/sync-emily-context.sh --all
#   bash operator/scripts/sync-emily-context.sh --prod
#   bash operator/scripts/sync-emily-context.sh --scenarios
#
# Idempotent: re-runs produce no changes when context is already aligned.

set -euo pipefail

TARGET_PROD=false
TARGET_SCENARIOS=false

for arg in "$@"; do
  case "$arg" in
    --prod)      TARGET_PROD=true ;;
    --scenarios) TARGET_SCENARIOS=true ;;
    --all)       TARGET_PROD=true; TARGET_SCENARIOS=true ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$TARGET_PROD" = false && "$TARGET_SCENARIOS" = false ]]; then
  echo "usage: $0 --prod | --scenarios | --all" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTEXT_DIR="$REPO_ROOT/context"
VOCAB_FILE="$REPO_ROOT/breakage/vocab/root-cause-categories.yaml"

if [[ ! -d "$CONTEXT_DIR" ]]; then
  echo "context dir not found: $CONTEXT_DIR" >&2
  exit 1
fi

# Build the ConfigMap YAML once; apply to each target.
TMP_CM="$(mktemp)"
trap 'rm -f "$TMP_CM"' EXIT

{
  echo "apiVersion: v1"
  echo "kind: ConfigMap"
  echo "metadata:"
  echo "  name: operator-context"
  echo "  namespace: operator"
  echo "data:"
  for f in "$CONTEXT_DIR"/*.md; do
    [[ -e "$f" ]] || continue
    key="$(basename "$f")"
    echo "  $key: |"
    sed 's/^/    /' "$f"
  done
  if [[ -f "$VOCAB_FILE" ]]; then
    echo "  root-cause-categories.yaml: |"
    sed 's/^/    /' "$VOCAB_FILE"
  fi
} > "$TMP_CM"

apply_to() {
  local label="$1" kubeconfig="$2"
  echo "[$label] applying operator-context…"
  KUBECONFIG="$kubeconfig" kubectl apply -f "$TMP_CM" >/dev/null
  echo "[$label] rollout-restarting k3s-operator…"
  KUBECONFIG="$kubeconfig" kubectl -n operator rollout restart deploy/k3s-operator >/dev/null
  KUBECONFIG="$kubeconfig" kubectl -n operator rollout status deploy/k3s-operator --timeout=90s
  echo "[$label] done"
}

if [[ "$TARGET_PROD" = true ]]; then
  PROD_KUBECONFIG="${PROD_KUBECONFIG:-$REPO_ROOT/infra/kubeconfig}"
  if [[ ! -f "$PROD_KUBECONFIG" ]]; then
    echo "prod kubeconfig not found at $PROD_KUBECONFIG" >&2
    exit 1
  fi
  apply_to prod "$PROD_KUBECONFIG"
fi

if [[ "$TARGET_SCENARIOS" = true ]]; then
  K3D_KUBECONFIG="$(k3d kubeconfig write scenarios)"
  apply_to scenarios "$K3D_KUBECONFIG"
fi
