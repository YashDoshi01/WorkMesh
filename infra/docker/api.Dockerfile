# One image for the whole API. Every API container in the gateway stack is started from it,
# which is what "N instances of the same application" means.
#
# The repository runs TypeScript directly (no compile step), so the runtime needs `tsx`.
# That is a deliberate simplicity trade-off: a few hundred ms more start-up than compiled JS.

# ---- stage 1: dependencies only -------------------------------------------------------------
FROM node:24.14.1-alpine3.22 AS deps
WORKDIR /app

# Only the manifests first, so this (slow) layer is rebuilt only when dependencies change,
# not on every source edit. All workspace manifests are needed so npm can resolve the lockfile.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/sample-worker/package.json apps/sample-worker/
COPY packages/shared/package.json packages/shared/
COPY packages/worker-sdk/package.json packages/worker-sdk/

# Production dependencies of the API workspace only (and what it depends on): no React, no test tools.
RUN npm ci --omit=dev --workspace @workmesh/api --ignore-scripts

# ---- stage 2: runtime ------------------------------------------------------------------------
FROM node:24.14.1-alpine3.22
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
# npm may place a dependency inside the workspace (apps/api/node_modules) when its version differs
# from one hoisted to the root (cron-parser does); copy that too or the import fails at start-up.
COPY --from=deps /app/apps/api/node_modules apps/api/node_modules
COPY apps/api apps/api
COPY packages/shared packages/shared
# migrate() reads ../../../../db/migrations relative to apps/api/src/db, i.e. /app/db/migrations
COPY db/migrations db/migrations

# Never run as root inside the container.
USER node
EXPOSE 3000

# Readiness, not just liveness: an instance that cannot reach the database should not receive traffic.
HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=6 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/readyz || exit 1

CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]
