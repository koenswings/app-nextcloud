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
# plus nextcloud.sql.id (one line, unique per dump) and the import markers
# 00-idea-import-begin.sh / zz-idea-import-end.sh (see below). The hook archive excludes
# data/db (hookExclude), so a restored instance has an empty datadir and the
# official MariaDB entrypoint imports this dump on its first start.
#
# The root password comes from the container env (MYSQL_ROOT_PASSWORD) and is
# handed to mariadb-dump through MYSQL_PWD; it is never printed or put on argv.
#
# Exit 0 = dump written and complete. Any other exit = the Engine treats the
# preHook as failed: postHook runs (maintenance off, dump, id, import markers and the
# backup-pending marker removed), then the fallback (stop) or fail. A partial dump is
# never left as nextcloud.sql.
set -eu

DIR="${IDEA_BACKUP_DB_DIR:-/docker-entrypoint-initdb.d}"
DB="${MYSQL_DATABASE:-nextcloud}"
OUT="$DIR/nextcloud.sql"
TMP="$DIR/.nextcloud.sql.tmp"
ID="$DIR/nextcloud.sql.id"
# Import markers (Axle, app-nextcloud#27 point 3): MariaDB's entrypoint runs initdb files in glob
# order, so these run just before and just after nextcloud.sql on a restore. A broken import
# (power cut, full disk, OOM, bad statement) leaves data/db/.idea-import-pending, and the db
# healthcheck stays unhealthy on it, so Nextcloud never starts on a half-imported database.
BEGIN="$DIR/00-idea-import-begin.sh"
END="$DIR/zz-idea-import-end.sh"
# app-nextcloud#29: app healthcheck treats maintenance as alive only while this exists.
# Hidden, so MariaDB initdb (`for f in *`) never sources it. Written just before the dump
# so the dump and borg window are covered; the few seconds after maintenance:on and before
# this script starts are well under the 45 s Docker retry budget. db-clean.sh removes it.
MARKER="$DIR/.idea-backup-pending"

log() { echo "backup-db-dump: $*" >&2; }

[ -d "$DIR" ] || { log "no dump folder $DIR (compose bind ./data/backup/db missing)"; exit 1; }
[ -n "${MYSQL_ROOT_PASSWORD:-}" ] || { log "MYSQL_ROOT_PASSWORD is not set"; exit 1; }

cleanup() { rm -f "$TMP" "$BEGIN.tmp" "$END.tmp"; }
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

# An older dump is never kept next to a new one: the import must not see two.
rm -f "$OUT" "$ID" "$BEGIN" "$END"

touch "$MARKER" || { log "cannot write backup marker $MARKER"; exit 1; }

MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mariadb-dump -uroot \
	--single-transaction --quick --routines --triggers --hex-blob \
	--default-character-set=utf8mb4 "$DB" > "$TMP" || { log "mariadb-dump failed"; exit 1; }

# Complete dumps end with "-- Dump completed on <date>" (not written on error).
tail -n 1 "$TMP" | grep -q '^-- Dump completed' || { log "dump is incomplete"; exit 1; }
# Nextcloud's own tables must be in it (oc_ prefix is the Nextcloud default).
# shellcheck disable=SC2016 # literal backticks
grep -q '^CREATE TABLE `oc_filecache`' "$TMP" || { log "dump has no oc_filecache table"; exit 1; }

# Sourced (not executable) by the MariaDB entrypoint, where DATADIR is the data dir.
cat > "$BEGIN.tmp" <<'MARK'
# idea#403 (written by backup-db-dump.sh): the dump import starts; zz-idea-import-end.sh clears it.
touch "${DATADIR:-/var/lib/mysql}/.idea-import-pending"
MARK
cat > "$END.tmp" <<'MARK'
# idea#403 (written by backup-db-dump.sh): the dump import ended without an error.
rm -f "${DATADIR:-/var/lib/mysql}/.idea-import-pending"
MARK
chmod 644 "$BEGIN.tmp" "$END.tmp"
mv "$BEGIN.tmp" "$BEGIN"
mv "$END.tmp" "$END"

sync "$TMP" 2>/dev/null || sync
mv "$TMP" "$OUT"
id="$(date -u +%Y%m%dT%H%M%SZ)-$(cat /proc/sys/kernel/random/uuid)"
printf '%s\n' "$id" > "$ID.tmp" && mv "$ID.tmp" "$ID"
sync
log "ok $(wc -c < "$OUT") bytes id $id"
