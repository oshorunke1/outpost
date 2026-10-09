# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f backend/Dockerfile -t outpost-backend:dev .
# One image runs the API (the default command), the worker and the migrate job (Compose sets the command).

FROM node:22.23.3-alpine AS base
WORKDIR /repo
RUN npm install --global pnpm@10.34.6
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY backend/package.json backend/

FROM base AS build
RUN pnpm install --frozen-lockfile --filter @outpost/backend
COPY backend/ backend/
RUN pnpm --filter @outpost/backend build

# Production dependencies only, so the runtime image carries no compiler, linter or test runner.
FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --filter @outpost/backend

FROM node:22.23.3-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=deps /repo/node_modules node_modules
COPY --from=deps /repo/backend/node_modules backend/node_modules
COPY backend/package.json backend/
COPY --from=build /repo/backend/dist backend/dist
COPY backend/migrations backend/migrations
WORKDIR /repo/backend
# The files stay owned by root, so the app user can read them but never change them.
USER node
EXPOSE 3000 9464
CMD ["node", "--import", "@opentelemetry/auto-instrumentations-node/register", "dist/server.js"]
