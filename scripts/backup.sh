#!/usr/bin/env bash
# T10.4 daily encrypted backup (doc 28: RPO <= 24h). Run once a day from cron / a scheduler:
#   DATABASE_URL=... BACKUP_PASSPHRASE=... [BACKUP_DIR=/backups] [RETENTION_DAYS=14] scripts/backup.sh
# Output: $BACKUP_DIR/inventory-<UTC timestamp>.dump.gpg = pg_dump custom format, encrypted
# with gpg symmetric AES-256 (integrity-protected). Needs pg_dump (same major as the server) + gpg;
# the postgres:18 image has both. Copy the file off-site (object storage) after it's written.
# The passphrase lives in the secret store, never next to the backups.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

url="${DATABASE_URL%%\?*}" # pg_dump rejects Prisma's ?schema=public
mkdir -p "$BACKUP_DIR"
export GNUPGHOME; GNUPGHOME="$(mktemp -d)"
trap 'rm -rf "$GNUPGHOME"' EXIT

out="$BACKUP_DIR/inventory-$(date -u +%Y%m%dT%H%M%SZ).dump.gpg"
pg_dump --format=custom --no-owner --no-privileges --dbname="$url" \
  | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 \
        --symmetric --cipher-algo AES256 --output "$out.part" 3< <(printf '%s' "$BACKUP_PASSPHRASE")
mv "$out.part" "$out" # only complete files carry the final name
echo "backup: $out ($(wc -c < "$out") bytes)"

# Retention: backup files older than RETENTION_DAYS (managed Postgres PITR covers the short term).
find "$BACKUP_DIR" -name 'inventory-*.dump.gpg' -mtime +"$RETENTION_DAYS" -print -delete
