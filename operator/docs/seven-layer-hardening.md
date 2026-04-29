# Seven-layer hardening

In April 2026 the agent autonomously rotated the postgres superuser password and rewrote a service Secret to authenticate as `postgres` while diagnosing what was actually a missing schema migration on a totally different database. The fix shipped in seconds. The fix was wrong on three independent axes — wrong premise, wrong scope, wrong identity. The agent reported success.

The incident was caught when a human noticed silent drift between the canonical `platform/postgres-superuser` Secret and the live cluster credentials. Recovery required restoring three different pieces of state and a manual schema migration.

The seven-layer hardening below was the structural response. Each layer makes a specific class of violation *impossible at the infrastructure level*, not "blocked by a prompt." Recovering the failure mode requires either physically modifying the K8s API, the cluster manifests, or the postgres pg_hba — none of which an autonomous agent can do without external intervention.

This document explains what each layer is, what specific violation it prevents, and where it lives in the codebase.

## Why layered

A single layer is brittle: the agent can route around a prompt, an LLM can be tricked, RBAC can be misconfigured. Layered defense means a single failure (a wrong prompt edit, an RBAC change, a model regression) doesn't unlock the underlying capability. Multiple layers must fail simultaneously for the bad action to land.

The layers below are ordered from "agent's tool layer" upward through the cluster API, the K8s control plane, and the postgres engine. They compose: violating any one requires a human-level escalation, not an agent-level one.

## Layer 1 — Shell back doors closed

**What it does**: rejects shell commands containing dangerous CLI substrings before execution.

**Where**: [`operator/src/tools/blocked-commands.ts`](../src/tools/blocked-commands.ts), shared by [`operator/src/tools/shell.ts`](../src/tools/shell.ts) and [`operator/src/tools/kubectl.ts`](../src/tools/kubectl.ts).

**Blocked substrings**: `kubectl`, `psql`, `helm`, `hcloud`, `doctl`, `vultr-cli`, `pg_dump`, `pg_restore`, `-U postgres`.

**Violation it prevents**: routing around the dedicated Tier-1/2/3 tool wrappers by calling those CLIs through `shell_exec` or `kubectl_exec`. Without this layer, the agent could (e.g.) call `kubectl_exec` into a postgres pod to run `psql -U postgres -c "ALTER USER ..."` and entirely bypass the postgres tool's identity narrowing (Layer 2). With this layer, the shell tool throws before the command runs.

**What's still possible**: anything that doesn't match a blocked substring. The agent can run arbitrary bash for things that don't shell out to the blocked CLIs. Whitelisting was rejected because it's brittle; the blocklist targets the specific escape hatches.

## Layer 2 — Database identity narrowed

**What it does**: the agent's `postgres_query` tool authenticates as `operator_user`, a non-superuser role with `pg_monitor` + `pg_read_all_data` cluster privileges and per-database `CONNECT`. The postgres watcher (the agent's continuous-monitoring path) uses the same identity.

**Where**: postgres role + grants in [`platform/postgres/cluster.yaml`](../../platform/postgres/cluster.yaml).

**Violation it prevents**: any DDL the agent might issue. `ALTER USER`, `CREATE USER`, `CREATE DATABASE`, `DROP TABLE`, `ALTER DATABASE OWNER TO` — all fail at the postgres planner with `permission denied for role operator_user`. Read access works for diagnostics; write access is read-only across most of the cluster.

**What's still possible**: the agent can read any database (for diagnosis). Inside `k3s_operator` (its own metadata database) it has full DML for goal/event tracking. Cross-database state mutation requires escalation to a different identity.

**Why this layer**: the April-2026 incident specifically issued `ALTER USER postgres WITH PASSWORD ...` from a service-namespace goal. Layer 2 makes that statement fail at the postgres engine, not at the agent's tool.

## Layer 3 — Secrets: create-only RBAC

**What it does**: the `k3s-operator` ServiceAccount has `create` (plus `get`, `list`, `watch`) verbs on Secrets — but not `update`, `patch`, or `delete`.

**Where**: [`services/operator/rbac.yaml`](../../services/operator/rbac.yaml).

**Violation it prevents**: rewriting an existing Secret to change credentials. The April-2026 incident rewrote `prod-publisher-reviews/publisher-reviews-secrets` to authenticate as `postgres`. Without Layer 3 that's a single Update API call. With Layer 3, the K8s API rejects the call at authorization time: `secrets is forbidden: User "system:serviceaccount:operator:k3s-operator" cannot update resource "secrets"`.

**What's still possible**: the agent can *create* a new Secret with a different name and transition the Deployment to reference it. This requires two audit-visible steps (create + the Deployment patch, the latter Tier-3-approved), each of which is harder to do silently than a single in-place update.

**Why this layer**: rotation should happen via "create new, point at new" not "edit existing." The former preserves a recovery path (the old Secret still exists); the latter destroys state.

## Layer 4 — Existing Secrets immutable

**What it does**: every live production Secret has `immutable: true`. The Kubernetes API rejects updates regardless of RBAC.

**Where**: applied as a per-Secret manifest field; verified at [`platform/admission-policies/`](../../platform/admission-policies/).

**Violation it prevents**: an RBAC widening that accidentally re-grants `update` on Secrets would still hit the immutability check: `field is immutable when immutable is set`.

**What's still possible**: rotation requires `delete + create` — two operations under different audit identities under the create-only RBAC of Layer 3. This intentionally splits a "rotate password" intent across two human-approved steps.

**Why this layer**: belt-and-suspenders behind Layer 3. RBAC is per-resource; immutability is per-instance. Both must fail simultaneously for an in-place update to land.

## Layer 5 — Admission policy on Secret mutations

**What it does**: a `ValidatingAdmissionPolicy` rejects `UPDATE` or `DELETE` operations on any Secret performed by `system:serviceaccount:operator:k3s-operator`.

**Where**: [`platform/admission-policies/no-operator-secret-mutations.yaml`](../../platform/admission-policies/no-operator-secret-mutations.yaml).

**Violation it prevents**: a malformed RBAC change widening Secret verbs would still be blocked at admission. The K8s API checks admission policies before running RBAC checks, so this layer fires earlier in the request lifecycle.

**What's still possible**: a manual `kubectl delete secret <name>` from a human admin succeeds (the policy targets only the operator's ServiceAccount). Operator-initiated mutations of any kind are rejected with the policy's reason message.

**Why this layer**: independent of RBAC. If RBAC ever drifts (manifest edit, Helm chart upgrade with bad templating), the admission policy still holds. Two independent layers, two independent failure modes — they don't share configuration paths.

## Layer 6 — Postgres superuser unreachable from pod CIDR

**What it does**: the postgres `pg_hba.conf` rejects `postgres` superuser connections originating from the K8s pod CIDR (`10.42.0.0/16`).

**Where**: [`platform/postgres/cluster.yaml`](../../platform/postgres/cluster.yaml).

**Violation it prevents**: even if a pod somehow obtained a Secret containing `postgresql://postgres:<real-pw>@...`, the connection itself fails with `pg_hba.conf rejects connection for host ..., user "postgres"`. The credential is useless from inside the cluster.

**What's still possible**: CNPG's internal replication (which uses internal pod IPs from a different range) and local unix-socket admin both still work. Operators with kubectl exec into the postgres pod can still admin the cluster.

**Why this layer**: the April-2026 incident *succeeded in writing* a Secret with `postgres:<new-pw>` credentials. Layer 6 is the one that says "even if you got the credential, you can't use it from where you are." It's specifically the lowest layer — the postgres engine — and is independent of every K8s-side enforcement above it.

## Layer 7 — Tier-3 approval (functional, not theoretical)

**What it does**: when the agent invokes a Tier-3 tool, execution pauses for human approval via Slack. Approve → the *exact* (tool, input) tuple executes under the approver's audit identity (`slack:<username>`). Deny → the tool returns a denial result and the agent must try a different approach (denial-recovery is a first-class behavior).

**Where**: tool tier annotations in [`operator/src/tools/`](../src/tools/); approval flow in the agent loop and Slack handler.

**Violation it prevents**: the agent autonomously executing a destructive operation (Secret delete, helm rollback, `postgres_query` with DML, etc.).

**What's still possible**: tier-2 mutations execute autonomously (wrapped by speculative-execution + auto-revert per [speculative-execution.md](speculative-execution.md)). Tier-3 mutations require explicit human approval that an operator sees and clicks.

**Why this layer**: defense above (Layers 1-6) is structural — it makes specific actions impossible. Layer 7 is procedural — it makes specific actions visible-and-deferrable. Both shapes of defense are needed; structural alone would be too brittle (the agent might find unanticipated combinations), and procedural alone would be too easy to circumvent (a malformed prompt could autonomous-execute a tier-3 action that the human would never have approved).

## Decommissioning a layer

If a layer is causing problems in production (false positives, blocking legitimate work), it should be widened *before* being removed. Specifically: the layer's purpose statement and the original incident it responded to should be reviewed. If those are still valid, the fix is to expand allowed behavior within the layer (e.g., explicit allow-list patterns), not to remove the layer wholesale. The April-2026 incident took ~6 hours of human-recovery time; each layer here cost a one-time engineering investment to prevent recurrence. The asymmetry favors keeping the layers and adapting their granularity.

## What the agent is left with

The agent retains the full ability to:

- Read cluster state (every API resource, every database, every log).
- Patch most Deployment fields (Tier-2, wrapped by speculative execution).
- Restart workloads and scale them.
- Create new Secrets and ConfigMaps (without modifying existing ones).
- Request Tier-3 approval for irreversible changes.

The agent loses the ability to:

- Modify existing Secrets in place.
- Issue cluster-affecting DDL via the database tool.
- Bypass the dedicated tool wrappers via shell access.
- Connect as the postgres superuser from inside the cluster.

Both lists are complete and intentional. The agent is operationally useful within the constrained surface; the constraint is what makes the autonomous loop safe.
