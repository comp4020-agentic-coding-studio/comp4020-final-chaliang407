# syntax = docker/dockerfile:1

# Astro (Node adapter, standalone) + Drizzle + better-sqlite3. The app must
# serve HTTP on 0.0.0.0:$PORT (fly.toml sets PORT) and publish README.md at
# /readme/ (spec/README.md says what's checked) — src/pages/readme/index.astro
# does the latter by reading README.md from the working directory at request
# time, so it has to be copied into both stages below.
#
# node:24-slim (glibc, matches mise.toml's node version) rather than an
# alpine base: better-sqlite3 needs a native binding, and glibc prebuilds are
# the reliable path without adding a build toolchain to the runtime image.
#
# better-sqlite3 has no prebuilt binary for this platform/Node combination,
# so `pnpm install` compiles it via node-gyp, which needs Python 3 and a
# C/C++ toolchain that node:24-slim doesn't ship. Both stages install that
# toolchain just for their own `pnpm install`; the runtime stage removes it
# again in the same layer so it never lands in the final image.

FROM node:24-slim AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && pnpm install --frozen-lockfile --prod \
  && apt-get purge -y --auto-remove python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/dist ./dist
COPY drizzle ./drizzle
COPY README.md ./README.md

CMD ["node", "./dist/server/entry.mjs"]
