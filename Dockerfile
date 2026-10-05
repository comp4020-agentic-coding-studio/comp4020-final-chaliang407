# syntax = docker/dockerfile:1

# Plain Node, no build step: tsconfig.json's `allowImportingTsExtensions`
# matches Node 24's native TypeScript support, so src/server.ts runs directly.
# README.md is read fresh per request (src/server.ts), so it's copied in too.

FROM node:24-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# better-sqlite3 needs a native build toolchain to compile its binding;
# installed and purged in this one layer so it doesn't bloat the image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && pnpm install --frozen-lockfile --prod \
  && apt-get purge -y --auto-remove python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY src ./src
COPY public ./public
COPY README.md ./README.md

CMD ["node", "src/server.ts"]
