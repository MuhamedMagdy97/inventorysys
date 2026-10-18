# T10.4/T12.5 images. One Dockerfile, three targets:
#   docker build --target web     -t inventory-web .
#   docker build --target worker  -t inventory-worker .
#   docker build --target migrate -t inventory-migrate .   # once per deploy: prisma migrate deploy
# All run as the non-root `node` user. Config comes only from env at runtime (doc 26).

FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Full dependency tree (postinstall = prisma generate → src/generated/prisma).
FROM base AS deps
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

# Web: Next standalone server (only the traced node_modules), static assets beside it.
FROM base AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

# Worker: one esbuild bundle (Prisma client + inlined query-compiler wasm, adapter-pg, pg-boss),
# no node_modules. `require("pg-native")` stays unresolved; pg only loads it when asked to.
FROM deps AS worker-build
COPY . .
RUN npm run build:worker

FROM base AS worker
ENV NODE_ENV=production
COPY --from=worker-build --chown=node:node /app/dist ./dist
USER node
CMD ["node", "--enable-source-maps", "dist/worker.mjs"]

# Migrate: prisma CLI + dotenv only, pruned from the lockfile tree (no network).
FROM deps AS migrate-deps
RUN node -e "const fs=require('fs'),p=require('./package.json');p.dependencies={prisma:p.devDependencies.prisma,dotenv:p.devDependencies.dotenv};delete p.devDependencies;delete p.scripts;fs.writeFileSync('package.json',JSON.stringify(p))" \
  && npm prune --omit=dev

FROM base AS migrate
COPY --from=migrate-deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json prisma.config.ts ./
COPY --chown=node:node prisma ./prisma
USER node
CMD ["npx", "prisma", "migrate", "deploy"]
