#!/bin/sh
# hooks/app-healthcheck.sh — Docker healthcheck for nextcloud-app (app-nextcloud#29).
#
# Alive when:
#   - status.php returns HTTP 200 and the body contains
#     "maintenance":false,"needsDbUpgrade":false  (normal ready state), or
#   - status.php returns HTTP 503, the body contains "maintenance":true, and
#     the IDEA backup marker exists and is no older than
#     IDEA_BACKUP_MARKER_MAX_AGE_S seconds (default 7200 = 2 h). The marker is
#     written at the start of backup-db-dump.sh and removed by backup-db-clean.sh.
#     A stuck maintenance window whose marker was left behind goes unhealthy once
#     the marker is older than that bound.
# Everything else fails (down, a stuck or manual maintenance window, an upgrade
# still in maintenance after start_period, or an expired marker). Quiet: no
# output on success or failure.
# x-app.healthCheck in compose.yaml stays stricter; updateApp's Health step uses that.
#
# Marker age is the file's mtime (touch sets it; a content timestamp is unnecessary).
# A future mtime is treated as fresh: a backward clock step or NTP correction
# must not fail a live backup. Age is compared in seconds; exactly MAX_AGE_S is
# still fresh, one second older is not.
# GNU stat -c %Y (Debian Nextcloud image and this box); BSD stat -f %m as fallback.
set -eu

URL="${IDEA_NC_HEALTH_URL:-http://127.0.0.1/status.php}"
MARKER="${IDEA_BACKUP_MARKER:-/idea-backup-db/.idea-backup-pending}"
MAX_AGE_S="${IDEA_BACKUP_MARKER_MAX_AGE_S:-7200}"
case "$MAX_AGE_S" in
	''|*[!0-9]*) MAX_AGE_S=7200 ;;
esac
[ "$MAX_AGE_S" -gt 0 ] || MAX_AGE_S=7200

# 0 = marker exists and is fresh (or has a future mtime). 1 = missing, unreadable, or too old.
marker_is_fresh() {
	[ -f "$1" ] || return 1
	mtime=$(stat -c %Y "$1" 2>/dev/null) || mtime=$(stat -f %m "$1" 2>/dev/null) || return 1
	now=$(date +%s) || return 1
	age=$((now - mtime))
	[ "$age" -le "$MAX_AGE_S" ]
}

tmp=$(mktemp) || exit 1
trap 'rm -f "$tmp"' EXIT

code=$(curl -sS -m 4 -o "$tmp" -w '%{http_code}' "$URL") || exit 1

if [ "$code" = 200 ] && grep -q '"maintenance":false,"needsDbUpgrade":false' "$tmp"; then
	exit 0
fi
if [ "$code" = 503 ] && grep -q '"maintenance":true' "$tmp" && marker_is_fresh "$MARKER"; then
	exit 0
fi
exit 1
