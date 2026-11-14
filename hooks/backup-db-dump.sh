#!/bin/sh
# hooks/backup-db-dump.sh — preHook step 2 of x-app.backup (idea#403), runs in nextcloud-db.
#
# The Engine runs (no shell, no extra env, cwd = instance folder):
#   timeout --signal=TERM --kill-after=10s <hookTimeout> \
#     docker compose exec -T -- nextcloud-db /idea/backup/db-dump.sh
# after step 1 put Nextcloud in maintenance mode.
#
# Writes a consistent logical dump of the Nextcloud database to
#   /docker-entrypoint-initdb.d/nextcloud.sql   (host: <instance>/data/backup/db/)
# plus nextcloud.sql.id (one line, unique per dump). The hook archive excludes
# data/db (hookExclude), so a restored instance has an empty datadir and the
# official MariaDB entrypoint imports this dump on its first start.
#
# The root password comes from the container env (MYSQL_ROOT_PASSWORD) and is
# handed to mariadb-dump through MYSQL_PWD; it is never printed or put on argv.
#
# Exit 0 = dump written and complete. Any other exit = the Engine treats the
# preHook as failed: postHook runs (maintenance off, dump removed), then the
# fallback (stop) or fail. A partial dump is never left as nextcloud.sql.
set -eu

DIR="${IDEA_BACKUP_DB_DIR:-/docker-entrypoint-initdb.d}"
DB="${MYSQL_DATABASE:-nextcloud}"
OUT="$DIR/nextcloud.sql"
TMP="$DIR/.nextcloud.sql.tmp"
ID="$DIR/nextcloud.sql.id"

log() { echo "backup-db-dump: $*" >&2; }

[ -d "$DIR" ] || { log "no dump folder $DIR (compose bind ./data/backup/db missing)"; exit 1; }
[ -n "${MYSQL_ROOT_PASSWORD:-}" ] || { log "MYSQL_ROOT_PASSWORD is not set"; exit 1; }

cleanup() { rm -f "$TMP"; }
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

# An older dump is never kept next to a new one: the import must not see two.
rm -f "$OUT" "$ID"

MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mariadb-dump -uroot \
	--single-transaction --quick --routines --triggers --hex-blob \
	--default-character-set=utf8mb4 "$DB" > "$TMP" || { log "mariadb-dump failed"; exit 1; }

# Complete dumps end with "-- Dump completed on <date>" (not written on error).
tail -n 1 "$TMP" | grep -q '^-- Dump completed' || { log "dump is incomplete"; exit 1; }
# Nextcloud's own tables must be in it (oc_ prefix is the Nextcloud default).
# shellcheck disable=SC2016 # literal backticks
grep -q '^CREATE TABLE `oc_filecache`' "$TMP" || { log "dump has no oc_filecache table"; exit 1; }

sync "$TMP" 2>/dev/null || sync
mv "$TMP" "$OUT"
id="$(date -u +%Y%m%dT%H%M%SZ)-$(cat /proc/sys/kernel/random/uuid)"
printf '%s\n' "$id" > "$ID.tmp" && mv "$ID.tmp" "$ID"
sync
log "ok $(wc -c < "$OUT") bytes id $id"
