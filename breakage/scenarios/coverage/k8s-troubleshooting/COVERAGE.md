# Coverage map — Kubernetes troubleshooting

The canon of "first 90 days" symptoms every operator encounters. Tracked against the [Kubernetes docs debug chapter](https://kubernetes.io/docs/tasks/debug/) table of contents and the [kubectl troubleshooting cheat sheet](https://kubernetes.io/docs/reference/kubectl/cheatsheet/#viewing-and-finding-resources).

## Status legend

- ✅ Covered — scenario exists and has a baseline
- 🟡 Partial — scenario exists but no baseline yet, OR a related anchor covers it incidentally
- ⏳ To-do — in scope, not yet written
- ⏭ Out-of-scope — requires infra the k3d-scenarios cluster doesn't have (GPU, multi-cluster federation, etc.)

## Pattern map

| k8s pattern | Status | Scenario | Notes |
|---|---|---|---|
| Pod Pending — insufficient CPU/memory on any node | ✅ | `pod-pending-request-too-high-advocate` | resources.requests.cpu above node capacity |
| Pod Pending — taints / nodeSelector / affinity mismatch | ⏳ | | needs taint injector or nodeSelector mutation |
| Pod Pending — PVC not bound | ⏳ | | requires StorageClass + PVC fixture |
| ImagePullBackOff — wrong tag / registry | 🟡 | `image-pull-failure-advocate` (anchor) | anchor covers typo case |
| ImagePullBackOff — missing imagePullSecret | ⏳ | | needs private-registry fixture |
| CrashLoopBackOff — bad command / entrypoint exit | ✅ | `bad-command-crashloop-advocate` | |
| CrashLoopBackOff — missing env var | 🟡 | `env-var-missing-advocate` (anchor) | anchor covers this |
| CrashLoopBackOff — failing health checks | 🟡 | `liveness-probe-always-fails-advocate` (anchor) | anchor covers probe side |
| ContainerCreating stuck — missing ConfigMap/Secret volume | ⏳ | | needs fixture with configMap volume; retired 2026-04-23 — fixture has no volumes |
| Pod admission blocked — missing ServiceAccount | ✅ | `serviceaccount-missing-advocate` | uses the SA-not-found admission error to exercise the "no pods created" diagnostic family |
| Service endpoints empty — selector mismatch | ⏳ | | needs service-patch injector |
| Service endpoints empty — pods not Ready | 🟡 | `readiness-probe-misconfigured-advocate` (anchor) | covers the probe side |
| DNS resolution failure from pod | ⏳ | | needs CoreDNS patch injector |
| RBAC denied on ServiceAccount call | ⏳ | | needs RBAC-patch injector |
| Ingress 404 — path mismatch | ⏳ | | needs ingress-patch injector |
| Ingress 502 — backend service not reachable | ⏳ | | needs ingress-patch injector + service manipulation |
| NodeNotReady — kubelet down | ⏭ | | requires node-level access we don't grant Emily |
| Network policy blocking legitimate traffic | 🟡 | | `network-policy` injector exists; scenario not authored |

## Next-tranche candidates (Week 3 authoring priority)

1. **`pod-pending-node-selector-mismatch-advocate`** — nodeSelector that no node satisfies → Pending
2. **`service-selector-mismatch-advocate`** — Service selector changed, endpoints empty, traffic 404s (needs service-patch injector — ~30 LOC)
3. **`dns-resolution-failure-advocate`** — patch CoreDNS to drop `.svc.cluster.local` resolution (needs coredns-patch injector)
4. **`crashloop-oom-at-startup-advocate`** — distinct from the anchor OOM: this one OOMs on boot, not after steady-state load

## Known limits

- Every scenario targets one namespace; cross-namespace RBAC scenarios live in their own tranche when that tranche exists.
- The k3d-scenarios cluster has one node (one control-plane, one agent); scenarios that require node diversity (taint distribution, affinity across zones) aren't reproducible here.
