# Getting started

This is a clone-to-reproduce-result walkthrough. By the end you will have:

1. A k3d cluster running an autonomous Kubernetes operator agent (referred to as "Emily" throughout).
2. A PostgreSQL instance with `pgvector` and the framework's experience-base schema.
3. An embeddings endpoint serving `BAAI/bge-m3` (1024-dim).
4. A working scenario run that produces a scorecard.

Target time: 90 minutes from a clean machine. The longest single step is pulling the embeddings model on first cold-start (~60s).

## Prerequisites

You need:

- **macOS, Linux, or WSL2.** The reference setup runs in a Linux VM ("orch") on macOS Apple Silicon, but any Linux/macOS host with the dependencies below works.
- **Docker** (for k3d).
- **k3d** (`brew install k3d` or [installer](https://k3d.io)).
- **kubectl** matching the k3d version.
- **Node.js 20+** and **npm**.
- **PostgreSQL 14+ with `pgvector`** (extension version 0.5.0+). Locally, `apt install postgresql-16-pgvector` or the homebrew equivalent. The reference setup uses Postgres 17 + pgvector 0.8.2.
- **An Anthropic API key** (`ANTHROPIC_API_KEY`). Other providers can be wired in by editing `operator/src/agent.ts`'s model config.
- **An OpenAI-compatible embeddings endpoint serving a 1024-dim model.** The reference setup uses `text-embeddings-inference` (TEI) running `BAAI/bge-m3`. You can:
  - Run TEI locally: `docker run -p 8080:80 ghcr.io/huggingface/text-embeddings-inference:cpu-1.7 --model-id BAAI/bge-m3`
  - Use OpenAI's `text-embedding-3-small` (1536-dim — requires updating `experience-base/migrations/003_*.sql` to `vector(1536)` before bootstrapping).
  - Use any other 1024-dim provider; set `BREAKAGE_EMBEDDING_URL`.

## Step 1 — Clone and install

```bash
git clone https://github.com/odmarkj/agent-breakage.git
cd <repo>/breakage
npm install
cd ../operator
npm install
cd ..
```

## Step 2 — Postgres + experience base

Create the role and database, then apply migrations:

```bash
sudo -u postgres psql <<SQL
CREATE ROLE breakage WITH LOGIN PASSWORD 'breakage-changeme';
CREATE DATABASE breakage OWNER breakage;
\c breakage
CREATE EXTENSION IF NOT EXISTS vector;
SQL

cd breakage
BREAKAGE_DATABASE_URL='postgresql://breakage:breakage-changeme@127.0.0.1:5432/breakage' \
  npm run migrate
```

Then seed the experience base with bootstrap postmortems:

```bash
BREAKAGE_DATABASE_URL='postgresql://breakage:breakage-changeme@127.0.0.1:5432/breakage' \
BREAKAGE_EMBEDDING_URL='http://localhost:8080/embeddings' \
BREAKAGE_EMBEDDING_MODEL='BAAI/bge-m3' \
BREAKAGE_EMBEDDING_DIM=1024 \
  npm run seed
```

Expected output: 11+ postmortems loaded into the `postmortems` table. These bootstrap entries are extracted from the historical incident log at `~/Apps/k3s/AUTONOMY.md` (advocate cascade, secret rotation, etc.) plus categorical seeds for cpu-throttling and replica-loss patterns. Without bootstrap, the agent's first scenario has no retrieval to draw from.

## Step 3 — k3d cluster + Emily deployment

Create the cluster:

```bash
k3d cluster create scenarios --servers 1 --agents 1 --no-lb
k3d kubeconfig write scenarios
```

Build and load the operator image (the agent itself):

```bash
cd operator
docker build -t k3s-operator:scenarios -f Dockerfile .
k3d image import k3s-operator:scenarios -c scenarios
```

Apply the operator deployment:

```bash
cd ..
ANTHROPIC_API_KEY="<your-key>" \
  bash breakage/deploy/operator/apply.sh
```

This creates the `operator` namespace, applies RBAC, builds an `operator-context` ConfigMap from `context/*.md` and the controlled vocabulary, sets `operator-secrets` with the Anthropic key, and deploys the operator Pod. Expected: `kubectl --context=k3d-scenarios -n operator get pods` shows `k3s-operator` Running 1/1.

## Step 4 — Apply the prod-advocate fixture

The anchor scenarios target a `prod-advocate` namespace running a small fixture (busybox + a shell script that emits readiness signals). Create it:

```bash
kubectl --context=k3d-scenarios apply -k breakage/fixtures/prod-advocate
```

## Step 5 — Start the runner and synthetic approver

```bash
cd breakage
set -a && source ../.env && set +a    # exports ANTHROPIC_API_KEY etc.
K3DKC="$(k3d kubeconfig write scenarios)"

BREAKAGE_KUBECONFIG="$K3DKC" \
BREAKAGE_DATABASE_URL='postgresql://breakage:breakage-changeme@127.0.0.1:5432/breakage' \
BREAKAGE_PORT=8088 \
BREAKAGE_RETRIEVAL_MAX_DISTANCE=0.40 \
BREAKAGE_EMBEDDING_URL='http://localhost:8080/embeddings' \
  ./node_modules/.bin/tsx src/runner/index.ts &

SYNTH_APPROVER_PORT=8089 \
  ./node_modules/.bin/tsx src/synthetic-approver/index.ts &

curl -sf http://127.0.0.1:8088/health
curl -sf http://127.0.0.1:8089/health
```

Both endpoints should respond with JSON `{ ok: true, ... }`.

## Step 6 — Run a scenario

A single anchor scenario, end-to-end:

```bash
./scripts/scenario-run.sh secret-missing-key-advocate
```

What this does:

1. Calls `POST /run` on the runner with the scenario id.
2. Runner registers the scenario as active (so postmortems posted afterward are associated with it).
3. Injector removes the `SESSION_SECRET` key from the `advocate-secrets` Secret.
4. `drive-emily.ts` sends a synthetic alert message into the operator's chat endpoint, simulating a watcher event.
5. The operator runs its agent loop: retrieval → tool calls → eventually `write_postmortem` → which POSTs to `/capture-postmortem`.
6. Runner pairs the captured postmortem with the active scenario, scores it, persists with `source='scenario'`, runs the injector's undo to clean up.
7. Output: a JSON `ScorecardRun` summary printed to stdout, plus a row in the `postmortems` table.

Expected wall-clock: 3–6 minutes for this scenario at default model (Sonnet 4.6) — single-digit minutes for most anchor scenarios.

## Step 7 — Generate a scorecard

After running scenarios, summarize:

```bash
BREAKAGE_DATABASE_URL='postgresql://breakage:breakage-changeme@127.0.0.1:5432/breakage' \
  ./node_modules/.bin/tsx src/scorecard/report.ts
```

Output: `breakage/reports/scorecard-<timestamp>.md` plus updated `breakage/reports/scorecard-latest.md`. Per-scenario means, per-category rollups, retrieval-impact delta. Read it with [interpreting-scorecards.md](interpreting-scorecards.md).

## Reproducing the falsification result

The falsification finding (`breakage/reports/falsification-test-2026-04-24.md`) compares the agent's performance with real retrieval (TEI embedder, full corpus) against control (deterministic embedder — semantically random). To reproduce:

```bash
# TEI arm: 3 scenarios × 20 reps each
SCENARIOS="secret-missing-key-advocate cpu-limit-throttling-advocate readiness-probe-misconfigured-advocate" \
REPS=20 \
  bash breakage/scripts/falsify-tei.sh

# Control arm: same scenarios with deterministic embedder
SCENARIOS="secret-missing-key-advocate cpu-limit-throttling-advocate readiness-probe-misconfigured-advocate" \
REPS=20 \
  bash breakage/scripts/falsify-control.sh
```

Wall-clock: ~5 hours per arm at single-runner sequential execution. ~$30-60 in API credits per arm.

The expected result, per the report:

| Scenario | TEI mean | Control mean | Δ | p |
|---|---|---|---|---|
| secret-missing-key | 0.863 | 0.805 | +0.058 | <0.05 |
| cpu-limit-throttling | 0.682 | 0.592 | +0.091 | ns |
| readiness-probe | 0.858 | 0.889 | −0.032 | ns |
| pooled | 0.801 | 0.762 | +0.039 | ns |

The framework's compounding mechanism produces a small-but-real positive effect on the densest-corpus scenario, weak signal on others, no signal on the third. The follow-on corpus-density sweep experiment — and its results — appear in `breakage/reports/corpus-density-sweep-*.md`.

If your reproduction lands within ~0.05 of these numbers per cell, you have a working framework. Differences larger than that probably indicate environment drift (different model version, embedder, corpus state, scenario fixture) — the diagnostic question is which one.

## Common failure modes during setup

- **`postgres can't find pgvector`**: extension not installed in *your* database. Run `\c breakage` first, then `CREATE EXTENSION vector;`.
- **`ScenarioFailedSchemaValidation`**: scenario YAML doesn't match the JSON Schema. Run `npm run scenarios -- --validate` for the specific error. Typically indicates a vocab-id typo.
- **`/retrieve returns 0 results`**: either `BREAKAGE_RETRIEVAL_MAX_DISTANCE` is filtering everything (try with `maxDistance: 1.0` in the query) or the embedder is unreachable. Check `/health` on your TEI endpoint.
- **`capture-postmortem → 409`**: scenario's time budget elapsed before the agent wrote its postmortem. Increase `time_budget_s` in the scenario YAML, or check whether the agent is hitting tool-round limits in `operator/src/agent.ts`.
- **`HNSW index missing`**: re-run `npm run migrate` to apply migration 004. Older corpora used `ivfflat` and returned 0–3 rows sporadically at small corpus sizes.

## What to read next

- To author a new scenario: [authoring-scenarios.md](authoring-scenarios.md).
- To make sense of scorecard output: [interpreting-scorecards.md](interpreting-scorecards.md).
- For the agent's own architecture (the seven-layer hardening, tier-based approval, speculative execution): `../../operator/docs/`.
