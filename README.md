# WorkMesh

WorkMesh is a durable job scheduling and workflow **control plane**. Applications submit background jobs over HTTP. WorkMesh persists those jobs in PostgreSQL, makes eligible jobs available to **customer-owned worker processes**, tracks attempts, and exposes state through an API and (later) a dashboard.

This repository follows a phased implementation plan in [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md). The product name is WorkMesh; the plan document originated as “TaskForge.”

**Current milestone: Phase 10 (product redesign) on top of the complete Phase 0-9 plan** — jobs are submitted over HTTP (optionally delayed, with a priority), executed by separate worker processes, retried with exponential backoff, and recovered if a worker dies (leases + fencing). Recurring cron schedules create jobs automatically, and workflows run groups of jobs in dependency order. A React dashboard (operator plane, API-key roles, audit log) lets a human watch and control it. Workers and programmatic clients are not authenticated until Phase 8.

## Architecture (target)

```text
Customer application / Dashboard / Worker SDK
                    |
                    v
         NGINX gateway + load balancer      (Phase 7)
                    |
          +---------+---------+
          v                   v
    API instance A       API instance B     (same modular monolith)
          |                   |
          +---------+---------+
                    v
              PostgreSQL                    (source of truth)
                    ^
                    |
       Worker SDK processes on
       customer-managed machines            (Phase 2+)
```

PostgreSQL is the durable source of truth. API instances must not keep durable job state only in process memory. WorkMesh does **not** claim exactly-once execution of arbitrary external side effects. Execution is **at-least-once**.

## Prerequisites

- Node.js 24.x (this repo was last verified on Node `v24.14.1` and npm `11.11.0`)
- npm 11+
- Docker Desktop (or another engine that can run Compose) for PostgreSQL

## Setup

```bash
git clone <this-repo>
cd WorkMesh
copy .env.example .env   # Windows: copy  |  Unix: cp .env.example .env
npm install
npm run db:up
```

Wait until Postgres is healthy (`docker compose -f infra/compose.yaml ps`). Local credentials in Compose are **development-only** (`workmesh` / `workmesh`). Do not use them in production. Do not commit `.env`.

## Commands

| Command                    | Purpose                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| `npm run typecheck`        | TypeScript project-references build                                           |
| `npm run lint`             | ESLint                                                                        |
| `npm run format`           | Prettier write                                                                |
| `npm run format:check`     | Prettier check                                                                |
| `npm test`                 | Unit tests (`node:test` via `tsx`)                                            |
| `npm run test:integration` | Integration tests (needs `npm run db:up`; uses database `workmesh_test`)      |
| `npm run dev:worker`       | Run the sample worker (needs the API running)                                 |
| `npm run dev:api`          | Run the API (applies migrations on start)                                     |
| `npm run dev:dashboard`    | Run the dashboard dev server on http://localhost:5173                         |
| `npm run build:dashboard`  | Typecheck and build the dashboard to `apps/dashboard/dist`                    |
| `npm run test:dashboard`   | Dashboard tests (Vitest + Testing Library)                                    |
| `npm run keys -- <create   | list                                                                          | revoke>` | Create, list and revoke machine API keys (needs the API running and `OPERATOR_API_KEY`)         |
| `npm run bench -- <perf    | failure                                                                       | ...>`    | Repeatable performance and failure experiments on an isolated stack (see `docs/PERFORMANCE.md`) |
| `npm run gateway:up`       | Build and start NGINX + 2 API instances + PostgreSQL on http://localhost:8080 |
| `npm run gateway:down`     | Stop that stack                                                               |
| `npm run gateway:logs`     | Follow the stack's logs (NGINX logs JSON per request)                         |
| `npm run test:gateway`     | End-to-end tests of that stack (needs Docker, about 90 s)                     |
| `npm run db:up`            | Start PostgreSQL                                                              |
| `npm run db:down`          | Stop PostgreSQL                                                               |
| `npm run db:logs`          | Follow Postgres logs                                                          |

## Repository layout

| Path                  | Responsibility                                    |
| --------------------- | ------------------------------------------------- |
| `apps/api`            | Modular-monolith backend (placeholder in Phase 0) |
| `apps/dashboard`      | React UI (Phase 6)                                |
| `apps/sample-worker`  | Example customer worker (Phase 2)                 |
| `packages/shared`     | Env validation, logging helpers                   |
| `packages/worker-sdk` | Customer worker SDK (Phase 2)                     |
| `db/migrations`       | SQL migrations (Phase 1+)                         |
| `infra/compose.yaml`  | Local PostgreSQL                                  |
| `tests/unit`          | Unit tests that do not need a database            |
| `docs/`               | Architecture, ADRs, learning log, master plan     |

## Troubleshooting

- **`engines` error on `npm install`:** use Node 24.x (`node -v`). nvm/fnm: `nvm use` / `fnm use` with `.nvmrc`.
- **Port 5432 already in use:** stop the other Postgres, or change the host port in `infra/compose.yaml`.
- **`docker` is not recognized:** install Docker Desktop (or another Compose-capable engine) and ensure `docker` is on `PATH`. Phase 0 on this development machine ran typecheck/lint/tests successfully; Compose was not started because `docker` was not installed.
- **Tests cannot resolve `@workmesh/shared`:** run `npm install` from the repository root so workspaces are linked.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Gateway and scaling](docs/GATEWAY.md)
- [The app (customer dashboard)](docs/DASHBOARD.md), [security](docs/SECURITY.md), [threat model](docs/THREAT_MODEL.md), [observability](docs/OBSERVABILITY.md)
- [Performance and failure tests](docs/PERFORMANCE.md), [recovery](docs/RECOVERY.md), [diagrams](docs/DIAGRAMS.md), [demo script](docs/DEMO.md), [interview notes](docs/INTERVIEW_NOTES.md)
- [Decisions](docs/DECISIONS.md)
- [Learning log](docs/LEARNING_LOG.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)

## License

MIT. See [LICENSE](LICENSE).

## Job API (Phase 1)

> **Since Phase 8 every machine endpoint needs an API key** (`Authorization: Bearer wm_...`; create one with `npm run keys -- create client`). The `curl` examples in the Phase 1-5 sections below were written before that; add `-H "authorization: Bearer $KEY"` (and use a `worker` key for the worker routes). See "API keys and security (Phase 8)" at the end.

```bash
npm run db:up && npm run dev:api
curl -X POST localhost:3000/jobs -H "content-type: application/json"   -d '{"type":"email.send","payload":{"to":"a@b.c"},"priority":5}'
curl localhost:3000/jobs/<id>
curl "localhost:3000/jobs?status=queued&type=email.send&limit=20&cursor=<nextCursor>"
```

Rules: `type` matches `^[a-z0-9][a-z0-9._-]{0,99}$`; `payload` is a JSON object up to 64 KiB; `priority` 0-100 (default 0); optional `runAt` ISO-8601 timestamp (stored, not yet acted on). Errors: `{ "error": { "code", "message", "details?", "requestId" } }`.

## Running a worker (Phase 2)

In two terminals (after `npm run db:up`):

```bash
npm run dev:api      # terminal 1
npm run dev:worker   # terminal 2: sample worker with email.send and report.build handlers
curl -X POST localhost:3000/jobs -H "content-type: application/json" \
  -d '{"type":"email.send","payload":{"to":"a@b.c"}}'
curl localhost:3000/jobs      # status goes queued -> running -> succeeded
```

`{"type":"report.build","payload":{"shouldFail":true}}` ends as `failed` with `lastError` set. Writing your own worker (outside this repository, `npm install workmesh-sdk-service`; inside it the same package is the workspace `@workmesh/worker-sdk`):

```ts
import { Worker } from "workmesh-sdk-service";
const worker = new Worker({ apiUrl: "http://localhost:3000", concurrency: 4 });
worker.register("email.send", async (job) => {
  /* your code */
});
await worker.start(); // later: await worker.stop() for a graceful shutdown
```

A job that fails is retried (default 3 attempts, backoff 1 s, 2 s, ... capped at 5 min); `report.build` with `shouldFail` therefore ends `failed` after its last attempt. If a worker process is killed mid-job, the job is picked up again after its lease (`LEASE_MS`, default 30 s) expires.

## Reliability (Phase 3)

| Setting (API `.env`) | Default | Meaning                                                            |
| -------------------- | ------- | ------------------------------------------------------------------ |
| `LEASE_MS`           | 30000   | A claimed job is owned this long; the SDK renews every third of it |
| `RETRY_BASE_MS`      | 1000    | First retry delay; doubles per attempt                             |
| `RETRY_MAX_MS`       | 300000  | Retry delay cap                                                    |
| `REAPER_INTERVAL_MS` | 5000    | How often each API instance sweeps for expired leases              |

Per job: `POST /jobs` accepts `maxAttempts` (1-20, default 3). `GET /jobs/:id/attempts` shows the per-attempt history. Handlers can throw `PermanentError` to skip retries. Delivery is **at-least-once**: write handlers to be idempotent (see [`docs/IDEMPOTENCY.md`](docs/IDEMPOTENCY.md)). Bugs and open problems found along the way are in [`docs/BUGS_FOUND.md`](docs/BUGS_FOUND.md).

## Delayed jobs, priorities and recurring schedules (Phase 4)

```bash
# run once, in the future
curl -X POST localhost:3000/jobs -H "content-type: application/json" \
  -d '{"type":"email.send","payload":{"to":"a@b.c"},"runAt":"2030-01-01T09:00:00Z","priority":50}'

# every weekday at 09:00 New York time
curl -X POST localhost:3000/schedules -H "content-type: application/json" \
  -d '{"name":"morning-report","cron":"0 9 * * 1-5","timezone":"America/New_York","jobType":"report.build","payload":{}}'
curl "localhost:3000/jobs?scheduleId=<id>"      # the jobs it created
curl -X PATCH localhost:3000/schedules/<id> -H "content-type: application/json" -d '{"enabled":false}'
```

- **Priority** is 0-100 (higher first). Waiting adds to it: each priority point is worth 60 seconds, so a priority-0 job outranks anything that becomes eligible 100 minutes after it. A retry restarts that clock.
- **Cron** has exactly five fields (minute hour day-of-month month day-of-week), evaluated in the schedule's IANA time zone (default UTC). At most one job per occurrence is created, even with many API instances running.
- **If the API was down**, only the latest overdue occurrence runs, not every missed one. Re-enabling a disabled schedule does not catch up.
- `SCHEDULER_INTERVAL_MS` (default 1000) controls how often each API instance checks for due schedules.
- Query-plan measurements and how to reproduce them: [`docs/QUERY_PLANS.md`](docs/QUERY_PLANS.md).

## Workflows (Phase 5)

```bash
curl -X POST localhost:3000/workflows -H "content-type: application/json" -d '{
  "name": "nightly-report",
  "nodes": [
    { "key": "fetch",  "type": "report.build" },
    { "key": "render", "type": "report.build", "dependsOn": ["fetch"] },
    { "key": "notify", "type": "email.send", "payload": {"to": "team@example.com"}, "dependsOn": ["render"] }
  ]}'
curl localhost:3000/workflows/<id>                      # per-node state + progress
curl -X POST localhost:3000/workflows/<id>/cancel       # skip what has not started
```

A node runs only after everything it depends on has **succeeded**; its job does not even exist until then. A cycle is rejected (`dependency cycle: a -> b -> a`). If a node fails for good, everything downstream is skipped while independent branches finish, and the workflow ends `failed`. Cancelling withdraws queued work but lets running jobs finish. Full semantics, limits and what is _not_ provided (e.g. results are not passed between nodes): [`docs/WORKFLOWS.md`](docs/WORKFLOWS.md). No new environment variables.

## Dashboard (Phase 6)

```bash
# add OPERATOR_API_KEY and VIEWER_API_KEY to .env first (see .env.example); the API will not start without them
npm run dev:api & npm run dev:worker & npm run dev:dashboard     # then open http://localhost:5173/dashboard/
```

Sign in with the viewer key (read-only) or the operator key (can submit, cancel, retry, enable/disable). It shows queue depth, throughput, failures, retries and timing percentiles from the real database, a chart of jobs finished, jobs with attempt history, workflows, schedules, worker health and an audit log of every change made from it. The server enforces every rule: for example a running job cannot be cancelled and a job inside a workflow cannot be retried, whatever the UI offers. Details, screens and security notes: [`docs/DASHBOARD.md`](docs/DASHBOARD.md). The operator endpoints live under `/ops/*` and need `Authorization: Bearer <key>`; the machine endpoints (workers, `POST /jobs`, ...) are unchanged and **still unauthenticated** until Phase 8.

## Gateway and two API instances (Phase 7)

```bash
# OPERATOR_API_KEY and VIEWER_API_KEY must be in .env
npm run gateway:up                       # then open http://localhost:8080/dashboard/
for i in 1 2 3 4; do curl -s -D - -o /dev/null localhost:8080/readyz | grep -i x-served-by; done   # alternates api-1 / api-2
docker stop workmesh-gateway-api-1-1     # keep calling the API: it keeps answering from api-2
npm run test:gateway                     # automated version of all of the above
```

Everything enters through NGINX on port 8080; the API containers publish no ports. Both API containers run the same image and share one PostgreSQL, so a job created through one is visible through the other. Behaviour, measured numbers and limitations (NGINX is a single point of failure; health checks are passive; containers on one laptop are not separate machines): [`docs/GATEWAY.md`](docs/GATEWAY.md). The dashboard now lives at `/dashboard/`.

## API keys and security (Phase 8)

```bash
npm run gateway:up                                           # rebuild so the new code and migration 0009 are applied
npm run keys -- create worker --account default --name "my laptop"     # prints the key ONCE
npm run keys -- create client --account default --name "demo client"
npm run keys -- list
```

```powershell
$env:WORKMESH_API_URL = "http://localhost:8080"; $env:WORKMESH_API_KEY = "<the worker key>"; npm run dev:worker
$h = @{ Authorization = "Bearer <the client key>" }
Invoke-RestMethod -Method Post -Uri http://localhost:8080/jobs -Headers $h -ContentType "application/json" -Body '{"type":"email.send","payload":{"to":"a@b.c"}}'
```

Keys are stored only as SHA-256 digests, can be revoked instantly on every instance, and are bound to an **account**: a client sees only its own jobs and a worker only claims its account's jobs. Logs never contain keys or payloads. `GET /ops/metrics` (viewer key) exposes queue depth, wait and run times, retries, failures, workers and expired leases. Details and limitations: [`docs/SECURITY.md`](docs/SECURITY.md), [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md), [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md).

## Measured performance (Phase 9)

Every figure below is from `bench/results/` and was taken on **one laptop with everything co-located** (AMD Ryzen 5 5600H, 12 logical cores, Docker Desktop, 2 API instances, PostgreSQL 17.6 with default settings, the load generator on the same machine). They show how this design behaves and where it saturates here; they are not a capacity claim for other hardware. Full tables, method and caveats: [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).

| Measurement                                  | Result                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| Job submissions through NGINX, 2 instances   | about 1,700 per second at 16 to 64 clients; p50 36 ms, p99 58 ms at 64 clients |
| One instance vs two                          | 1,155 vs 1,694 per second (1.47x on one machine)                               |
| Job completions (zero-work handlers)         | about 800 to 1,000 per second, flat from 1 to 8 workers                        |
| Claim with 19,000 jobs queued                | p50 8.4 ms, p99 10.3 ms                                                        |
| Controlled optimization (5 runs per variant) | submit +12.6%, completion +20.2%                                               |
| Instance killed during POST traffic          | 8 requests failed, 4 to 5 duplicate jobs, 0 acknowledged jobs lost             |
| Worker killed mid-job                        | all jobs finished; recovery 4.7 to 5.2 s with a 6 s lease                      |
| PostgreSQL stopped for about 12 s            | API stayed up; failures took 2.0 s (`503`); 0 acknowledged jobs lost           |

```bash
npm run bench -- perf        # about 7 minutes
npm run bench -- failure     # about 4 minutes
```

Known limits stated plainly: at-least-once delivery (not exactly-once), duplicate protection on `POST /jobs` is opt-in via an `Idempotency-Key` (see [`docs/SDK.md`](docs/SDK.md)), NGINX and PostgreSQL are single points of failure, no TLS. See [`docs/RECOVERY.md`](docs/RECOVERY.md) and [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

## The app: sign up and use it (Phase 10)

```bash
npm run gateway:up           # rebuilds everything, including the dashboard
# open http://localhost:8080/dashboard/ and choose "Create account"
```

You become the admin of a new organisation. From the app you can create API keys, invite teammates (as **admins**, who can change things, or **viewers**, who are read-only), submit jobs, manage schedules and see the audit log. Each organisation sees only its own data. Details, screens and security notes: [`docs/DASHBOARD.md`](docs/DASHBOARD.md); the reasoning: ADR-0031 in [`docs/DECISIONS.md`](docs/DECISIONS.md).

New optional settings (see `.env.example`): `SESSION_TTL_HOURS`, `PUBLIC_SIGNUP`, `COOKIE_SECURE` (set it to `true` once the site is behind HTTPS). Passwords cannot be reset by email (there is no email service): an admin removes and re-invites someone who forgot theirs.

## Queue jobs from your code (Phase 11)

The SDK is on npm as [`workmesh-sdk-service`](https://www.npmjs.com/package/workmesh-sdk-service):

```bash
npm install workmesh-sdk-service
```

```ts
import { WorkMesh } from "workmesh-sdk-service";

const workmesh = new WorkMesh({
  apiUrl: "http://localhost:8080",
  apiKey: process.env.WORKMESH_CLIENT_KEY!,
});
await workmesh.jobs.submit({
  type: "generate-invoice",
  payload: { orderId: "ORD-1024" },
  idempotencyKey: "invoice-ORD-1024", // a retry returns the same job instead of creating a second
});
```

A worker registers a handler with the same name (`worker.register("generate-invoice", ...)`); how the job is done lives only there. Full guide, options, errors and the exact retry rules: [`docs/SDK.md`](docs/SDK.md).
