# 07-build / 02 — Deploy, backups, restore drill (T10.4)

Binding for production. Nothing here is provisioned automatically; the owner creates the external resources.

## 1. Shape

| Piece | Where | Notes |
|---|---|---|
| `web` | `Dockerfile` target `web` (Next standalone `server.js`, non-root `node`, port 3000, `/api/health` healthcheck) | Behind one TLS reverse proxy that sets `X-Forwarded-For` (rate limiter keys on the last hop). One replica while the rate limiter is in-process. |
| `worker` | `Dockerfile` target `worker` (pg-boss jobs via tsx, non-root) | Exactly the jobs in `src/worker/index.ts`; safe to run 1–n (stately queues). |
| migrations | `docker compose -f docker-compose.prod.yml run --rm migrate` (`prisma migrate deploy` from the worker image) | Before every `up`. Never `migrate dev` in production. |
| Postgres | **Managed** (see §2) | `DATABASE_URL` only; TLS on. |
| backups | `scripts/backup.sh` daily + provider PITR | §3. |

Example: `docker-compose.prod.yml`. Env (all required unless noted): `DATABASE_URL`, `BETTER_AUTH_SECRET` (≥ 32 chars, `openssl rand -hex 32`), `BETTER_AUTH_URL` (public https URL), `CORS_ORIGINS` (optional), `BACKUP_PASSPHRASE` (backup job only). Web and worker validate env at boot and refuse to start on a bad or placeholder value (`src/server/env.ts`).

## 2. Managed Postgres choice

Requirements: PostgreSQL **18** (we use `uuidv7()`), PITR ≥ 7 days, automated daily snapshots, TLS, same region as the app, ≥ 2 vCPU / 4 GB for V1 volume (100k variants, 1M movements/yr).

Default: the managed Postgres of whichever platform hosts the containers (e.g. DigitalOcean Managed PostgreSQL, AWS RDS, Neon/Supabase with a dedicated compute). Pick by: PG 18 available, PITR, region next to the app, price. Not serverless-scale-to-zero for the primary (cold starts break the reserve latency target). Connection count: web pool (pg default 10) + worker (pg-boss ~ 10 + Prisma 10) per replica — stay well under the plan's limit; add the provider's pooler (PgBouncer, transaction mode — each interactive transaction keeps its connection, so row locks are unaffected) only if needed. pg-boss needs a direct (non-pooled) URL for LISTEN/advisory locks.

## 3. Backups (doc 28: RPO ≤ 24 h, RTO ≤ 4 h)

1. **Provider PITR** (primary recovery path, minutes of RPO).
2. **`scripts/backup.sh`** — provider-independent copy: `pg_dump -Fc` → `gpg --symmetric --cipher-algo AES256` → `inventory-<UTC>.dump.gpg`; local retention `RETENTION_DAYS` (14). Run daily from host cron: `30 2 * * * docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm backup`, then copy the file to object storage in another region (bucket with versioning + lifecycle 90 days). The passphrase lives in the secret store, never next to the backups.

## 4. Restore drill (quarterly) — `scripts/restore-drill.sh`

```bash
DATABASE_URL=<prod or replica URL> BACKUP_PASSPHRASE=... RECONCILE=1 scripts/restore-drill.sh backups/inventory-<ts>.dump.gpg
```

Creates `<db>_restore_drill` on the same server, decrypts + `pg_restore`s into it, compares row counts of the ledger tables with the source, checks the append-only triggers came back, replays the ledger (`scripts/reconcile.ts`, read-only), drops the scratch DB, prints PASS/FAIL and the elapsed time (the RTO evidence). Record each run below.

Real restore (disaster): provision a new DB (or PITR-restore at the provider), `pg_restore --no-owner --no-privileges --dbname=<new>` from the latest dump, run `prisma migrate deploy` (no-op if current), point `DATABASE_URL` at it, `up -d`, run `scripts/reconcile.ts`.

| Date | Source | Backup size | Restore | Row counts | Triggers | Reconciler | Result |
|---|---|---|---|---|---|---|---|
| 2026-10-09 | `inventory_p10` (perf seed: 20k variants, 141 309 movements, 2 900 audit rows) | 12.5 MB | 7 s (8 s total) | all 7 tables equal | 5 restored | 0 drift | PASS |

## 5. Deploy steps

1. CI green on the commit. 2. `docker compose ... build` (or pull tagged images). 3. `run --rm migrate`. 4. `up -d web worker`. 5. `curl -fsS https://<host>/api/health`. 6. Rollback = previous image tag; migrations are forward-only, so a rollback past a migration needs a restore (keep migrations additive).
