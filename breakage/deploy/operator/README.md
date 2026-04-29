# Deploy: Emily into `k3d-scenarios`

Minimal scenario-specific manifests for running the operator inside the scenarios cluster, so scenario runs drive Emily through her **real** watcher → triage → agent-loop path instead of the harness-driven `drive-emily.ts` shortcut.

Distinct from `services/operator/` (production deploy to Hetzner k3s) — this setup:

- Points at the breakage framework's HTTP endpoints (retrieval, capture-postmortem)
- Uses the host's native Postgres for Emily's `operator_test` DB (same one `drive-emily.ts` uses)
- Omits production watchers (GitHub, Slack, Alertmanager webhooks) — Emily listens to Kubernetes events only
- Runs with a locally-built image (`k3s-operator:scenarios`) imported via `k3d image import`

## Setup

```bash
# Build + import image (run from repo root)
docker build -t k3s-operator:scenarios -f operator/Dockerfile operator/
k3d image import k3s-operator:scenarios -c scenarios

# Apply manifests (expects k3d-scenarios kubectl context)
kubectl --context=k3d-scenarios apply -f breakage/deploy/operator/

# Wait for rollout
kubectl --context=k3d-scenarios -n operator rollout status deploy/k3s-operator --timeout=120s

# Verify Emily's /health
kubectl --context=k3d-scenarios -n operator port-forward svc/k3s-operator 8080:80 &
curl http://127.0.0.1:8080/health
```

## Files

- `namespace.yaml` — `operator` namespace
- `rbac.yaml` — ServiceAccount + ClusterRole (reads + tier-2 ops on cluster, no Secret mutations)
- `secret.yaml` — generated at apply time via `make-secret.sh` (never committed)
- `configmap.yaml` — cluster context + playbooks mounted at `/app/context`
- `deployment.yaml` — Emily Pod, points at breakage runner + synth approver + operator_test DB

## Notes on scope

- **No imagePullSecrets**: image is locally imported, not pulled
- **No Ingress**: access via `kubectl port-forward` or `Service` within-cluster
- **Wider RBAC than prod**: Emily needs to mutate deployments/secrets in scenario namespaces (prod-advocate etc.) for her tier-2 actions. Still create-only on Secrets per the 7-layer hardening (plan / AUTONOMY.md Ch 7).
- **DB via `host.k3d.internal`**: k3d auto-injects this hostname; resolves to the VM host where native Postgres lives.
