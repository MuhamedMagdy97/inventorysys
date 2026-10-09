# T10.4 images. One Dockerfile, two targets:
#   docker build --target web    -t inventory-web .
#   docker build --target worker -t inventory-worker .
# Both run as the non-root `node` user. Config comes only from env at runtime (doc 26).
# Migrations: run the worker image once per deploy: `npx prisma migrate deploy`.

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

# Worker: pg-boss jobs via tsx (+ prisma CLI for `migrate deploy`).
# ponytail: ships the full node_modules (~dev deps too); bundle the worker if image size matters.
FROM base AS worker
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json prisma.config.ts tsconfig.json ./
COPY --chown=node:node prisma ./prisma
COPY --from=deps --chown=node:node /app/src/generated ./src/generated
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
USER node
CMD ["npx", "tsx", "src/worker/index.ts"]
