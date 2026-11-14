#!/bin/sh
# 00-idea-restore.sh — first start after restoring a hook backup (idea#403).
#
# A hook archive (x-app.backup method hook) is taken with Nextcloud in maintenance
# mode and holds a MariaDB dump in data/backup/db (mounted here read-only as
# /idea-backup-db) instead of data/db. On restore, MariaDB imports the dump (empty
# datadir) and compose starts this container only once the DB is healthy. Here:
#   1. maintenance:mode --off  (config.php was copied with maintenance on)
#   2. files:scan --all        (file cache matches the files on disk)
# once per dump: the dump id is recorded in data/.idea-restore-id. A normal start
# (no dump, or an id already recorded) does nothing.
#
# Runs as www-data first in before-starting (00-), so the later hooks' occ calls
# do not meet maintenance mode. Fail open: always exits 0.
# Env (tests): OCC, IDEA_RESTORE_DB_DIR (default /idea-backup-db),
#   IDEA_RESTORE_STATE (default /var/www/html/data/.idea-restore-id)
set -u

run_occ() { if [ -n "${OCC:-}" ]; then "$OCC" "$@"; else php /var/www/html/occ "$@"; fi; }
log() { echo "idea-restore: $*"; }

DIR="${IDEA_RESTORE_DB_DIR:-/idea-backup-db}"
STATE="${IDEA_RESTORE_STATE:-/var/www/html/data/.idea-restore-id}"
[ -f "$DIR/nextcloud.sql" ] && [ -f "$DIR/nextcloud.sql.id" ] || exit 0
id="$(head -n 1 "$DIR/nextcloud.sql.id" 2>/dev/null)"
[ -n "$id" ] || exit 0
if [ -f "$STATE" ] && [ "$(head -n 1 "$STATE" 2>/dev/null)" = "$id" ]; then
	exit 0
fi

log "restored from hook backup $id"
run_occ maintenance:mode --off || log "WARNING maintenance:mode --off failed"
if run_occ files:scan --all; then
	printf '%s\n' "$id" > "$STATE" || log "WARNING could not record $STATE"
	log "files:scan --all done"
else
	log "WARNING files:scan --all failed (retried on next start)"
fi
exit 0
