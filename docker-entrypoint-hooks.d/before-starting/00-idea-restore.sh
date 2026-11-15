#!/bin/sh
# 00-idea-restore.sh — first start after restoring a hook backup (idea#403).
#
# A hook archive (x-app.backup method hook) is taken with Nextcloud in maintenance
# mode and holds a MariaDB dump in data/backup/db (mounted here read-only as
# /idea-backup-db) instead of data/db. On restore, MariaDB imports the dump (empty
# datadir) and compose starts this container only once the DB is healthy.
#
# Hook (before-starting, first, as www-data; quick, so the port-ready budget
# x-app.healthTimeout is not spent here):
#   1. occ maintenance:mode --off   (config.php was archived with maintenance on)
#   2. start a detached worker (setsid, survives this hook and the exec of Apache)
# Worker ("$0" --scan-worker <id>):
#   waits until http://127.0.0.1/status.php answers installed:true, maintenance:false
#   (Apache is up), then occ files:scan --all, logged to data/.idea-restore-scan.log,
#   and on success writes the done marker data/.idea-restore-id = <dump id>.
#
# Once per dump id: nothing happens when the marker already holds the id, or when
# there is no dump (a normal start). A crash or failed scan leaves no marker, so
# the next start tries again. data/.idea-restore-scan.running marks a worker in
# this container; the hook clears a leftover one first (a container start means no
# worker from an earlier run is alive).
# Paths in the container (on the disk: data/nextcloud/data/...):
#   /var/www/html/data/.idea-restore-id, .idea-restore-scan.log, .idea-restore-scan.running
#
# Fail open: the hook always exits 0.
# Env (tests): OCC, IDEA_RESTORE_DB_DIR (default /idea-backup-db),
#   IDEA_RESTORE_DATA (default /var/www/html/data), IDEA_RESTORE_CURL (default curl),
#   IDEA_RESTORE_STATUS_URL, IDEA_RESTORE_WAIT (s, default 3600), IDEA_RESTORE_INTERVAL (s, default 5)
set -u

run_occ() { if [ -n "${OCC:-}" ]; then "$OCC" "$@"; else php /var/www/html/occ "$@"; fi; }
log() { echo "idea-restore: $*"; }

DIR="${IDEA_RESTORE_DB_DIR:-/idea-backup-db}"
DATA="${IDEA_RESTORE_DATA:-/var/www/html/data}"
DONE="$DATA/.idea-restore-id"
LOG="$DATA/.idea-restore-scan.log"
RUNNING="$DATA/.idea-restore-scan.running"
URL="${IDEA_RESTORE_STATUS_URL:-http://127.0.0.1/status.php}"

done_id() { [ -f "$DONE" ] && head -n 1 "$DONE" 2>/dev/null; }

if [ "${1:-}" = "--scan-worker" ]; then
	id="${2:-}"
	[ -n "$id" ] || exit 0
	exec >> "$LOG" 2>&1
	echo "$(date -u +%FT%TZ) worker for $id: waiting for $URL"
	start=$(date +%s); waited=0; wait_max="${IDEA_RESTORE_WAIT:-3600}"; step="${IDEA_RESTORE_INTERVAL:-5}"
	while :; do
		s="$("${IDEA_RESTORE_CURL:-curl}" -fsS -m 4 "$URL" 2>/dev/null || true)"
		case "$s" in *'"installed":true'*'"maintenance":false'*) break ;; esac
		if [ "$waited" -ge "$wait_max" ]; then
			echo "$(date -u +%FT%TZ) gave up after ${waited}s (retried on next start)"
			rm -f "$RUNNING"; exit 0
		fi
		sleep "$step"; waited=$(( $(date +%s) - start ))
	done
	echo "$(date -u +%FT%TZ) Apache up after ${waited}s: occ files:scan --all"
	if run_occ files:scan --all; then
		printf '%s\n' "$id" > "$DONE"
		echo "$(date -u +%FT%TZ) files:scan --all done; marker $DONE = $id"
	else
		echo "$(date -u +%FT%TZ) files:scan --all failed (retried on next start)"
	fi
	rm -f "$RUNNING"
	exit 0
fi

# Hook mode.
rm -f "$RUNNING"
[ -f "$DIR/nextcloud.sql" ] && [ -f "$DIR/nextcloud.sql.id" ] || exit 0
id="$(head -n 1 "$DIR/nextcloud.sql.id" 2>/dev/null)"
[ -n "$id" ] || exit 0
[ "$(done_id)" = "$id" ] && exit 0

log "restored from hook backup $id"
run_occ maintenance:mode --off || log "WARNING maintenance:mode --off failed"
if ( set -C; printf '%s\n' "$id" > "$RUNNING" ) 2>/dev/null; then
	setsid "$0" --scan-worker "$id" < /dev/null > /dev/null 2>&1 &
	log "files:scan --all starts once Apache is up (log $LOG)"
else
	log "WARNING could not start the files:scan worker (retried on next start)"
fi
exit 0
