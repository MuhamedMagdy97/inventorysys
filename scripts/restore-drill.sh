#!/usr/bin/env bash
# T10.4 restore drill (doc 28: quarterly; RTO <= 4h). Restores a backup into a scratch DB on the
# same server, compares row counts with the source and (RECONCILE=1, needs node) replays the ledger.
#   DATABASE_URL=<source> BACKUP_PASSPHRASE=... scripts/restore-drill.sh backups/inventory-....dump.gpg
# KEEP_DRILL_DB=1 keeps the scratch DB (e.g. to reconcile it from another machine); default drops it.
set -euo pipefail
file="${1:?usage: restore-drill.sh <backup.dump.gpg>}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required}"

src="${DATABASE_URL%%\?*}"
src_db="${src##*/}"
scratch_db="${src_db}_restore_drill"
scratch="${src%/*}/$scratch_db"
export GNUPGHOME; GNUPGHOME="$(mktemp -d)"
trap 'rm -rf "$GNUPGHOME"' EXIT
start=$(date +%s)

psql -q -v ON_ERROR_STOP=1 --dbname="$src" -c "DROP DATABASE IF EXISTS \"$scratch_db\"" -c "CREATE DATABASE \"$scratch_db\""
gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "$file" 3< <(printf '%s' "$BACKUP_PASSPHRASE") \
  | pg_restore --no-owner --no-privileges --exit-on-error --dbname="$scratch"
echo "restore: $file -> $scratch_db in $(( $(date +%s) - start )) s"

status=0
printf '%-20s %12s %12s\n' table source restored
for t in company product_variant stock_balance stock_allocation inventory_movement audit_log reservation; do
  a=$(psql -Atq --dbname="$src" -c "SELECT count(*) FROM $t")
  b=$(psql -Atq --dbname="$scratch" -c "SELECT count(*) FROM $t")
  printf '%-20s %12s %12s\n' "$t" "$a" "$b"
  [ "$b" -gt 0 ] || [ "$a" -eq 0 ] || status=1 # the source may have grown since the dump; empty is a failure
done
# The append-only triggers must come back with the data (doc 08 / T1.3).
trig=$(psql -Atq --dbname="$scratch" -c "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('inventory_movement'::regclass, 'audit_log'::regclass)")
echo "ledger/audit triggers restored: $trig"; [ "$trig" -gt 0 ] || status=1

if [ "${RECONCILE:-0}" = "1" ]; then
  DATABASE_URL="$scratch" npx tsx scripts/reconcile.ts || status=1
fi
if [ "${KEEP_DRILL_DB:-0}" != "1" ]; then
  psql -q --dbname="$src" -c "DROP DATABASE \"$scratch_db\""
fi
echo "drill: $([ $status -eq 0 ] && echo PASS || echo FAIL) in $(( $(date +%s) - start )) s"
exit $status
