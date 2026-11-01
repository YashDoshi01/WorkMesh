# WorkMesh

WorkMesh is a durable job scheduling and workflow **control plane**. Applications submit background jobs over HTTP. WorkMesh persists those jobs in PostgreSQL, makes eligible jobs available to **customer-owned worker processes**, tracks attempts, and exposes state through an API and (later) a dashboard.

This repository follows a phased implementation plan in [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md). The product name is WorkMesh; the plan document originated as “TaskForge.”

**Current milestone: Phase 3** — jobs are submitted over HTTP, executed by separate worker processes, retried with exponential backoff, and recovered if a worker dies (leases + fencing). There is no scheduler/priorities, dashboard, or auth yet.

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

| Command                    | Purpose                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `npm run typecheck`        | TypeScript project-references build                                      |
| `npm run lint`             | ESLint                                                                   |
| `npm run format`           | Prettier write                                                           |
| `npm run format:check`     | Prettier check                                                           |
| `npm test`                 | Unit tests (`node:test` via `tsx`)                                       |
| `npm run test:integration` | Integration tests (needs `npm run db:up`; uses database `workmesh_test`) |
| `npm run dev:worker`       | Run the sample worker (needs the API running)                            |
| `npm run dev:api`          | Run the API (applies migrations on start)                                |
| `npm run db:up`            | Start PostgreSQL                                                         |
| `npm run db:down`          | Stop PostgreSQL                                                          |
| `npm run db:logs`          | Follow Postgres logs                                                     |

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
- [Decisions](docs/DECISIONS.md)
- [Learning log](docs/LEARNING_LOG.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)

## License

MIT. See [LICENSE](LICENSE).

## Job API (Phase 1)

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

`{"type":"report.build","payload":{"shouldFail":true}}` ends as `failed` with `lastError` set. Writing your own worker:

```ts
import { Worker } from "@workmesh/worker-sdk";
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
