#!/bin/sh
# hooks/app-healthcheck.sh — Docker healthcheck for nextcloud-app (app-nextcloud#29).
#
# Alive when:
#   - status.php returns HTTP 200 and the body contains
#     "maintenance":false,"needsDbUpgrade":false  (normal ready state), or
#   - status.php returns HTTP 503, the body contains "maintenance":true, and
#     the IDEA backup marker exists with age in
#     [-IDEA_BACKUP_MARKER_MAX_FUTURE_S, IDEA_BACKUP_MARKER_MAX_AGE_S]
#     (defaults 300 s and 7200 s). The marker is
#     /var/www/html/data/.idea-backup-pending (host: data/nextcloud/data/),
#     written by the backup preHook (touch, user 33) and removed by postHook
#     and by before-starting/00-idea-restore.sh on every start.
#     A stuck maintenance window whose marker was left behind goes unhealthy
#     once the marker is older than MAX_AGE_S, more than MAX_FUTURE_S in the
#     future, or has been cleared on start.
# Everything else fails (down, a stuck or manual maintenance window, an upgrade
# still in maintenance after start_period, or an expired marker). Quiet: no
# output on success or failure.
# x-app.healthCheck in compose.yaml stays stricter; updateApp's Health step uses that.
#
# Marker age is the file's mtime (touch sets it). age = now - mtime.
# Fresh only when -MAX_FUTURE_S <= age <= MAX_AGE_S (Axle, c5f9410 review):
# a small NTP step-back still allows a live backup; a leftover marker whose
# mtime is far in the future (Pi with no RTC / no NTP after reboot) is stale
# and does not hide stuck maintenance. Exactly MAX_AGE_S or -MAX_FUTURE_S is
# still fresh; one second outside is not.
# GNU stat -c %Y (Debian Nextcloud image and this box); BSD stat -f %m as fallback.
set -eu

URL="${IDEA_NC_HEALTH_URL:-http://127.0.0.1/status.php}"
MARKER="${IDEA_BACKUP_MARKER:-/var/www/html/data/.idea-backup-pending}"
MAX_AGE_S="${IDEA_BACKUP_MARKER_MAX_AGE_S:-7200}"
MAX_FUTURE_S="${IDEA_BACKUP_MARKER_MAX_FUTURE_S:-300}"
case "$MAX_AGE_S" in
	''|*[!0-9]*) MAX_AGE_S=7200 ;;
esac
[ "$MAX_AGE_S" -gt 0 ] || MAX_AGE_S=7200
case "$MAX_FUTURE_S" in
	''|*[!0-9]*) MAX_FUTURE_S=300 ;;
esac
[ "$MAX_FUTURE_S" -gt 0 ] || MAX_FUTURE_S=300

# 0 = marker exists and is fresh. 1 = missing, unreadable, too old, or too far in the future.
marker_is_fresh() {
	[ -f "$1" ] || return 1
	mtime=$(stat -c %Y "$1" 2>/dev/null) || mtime=$(stat -f %m "$1" 2>/dev/null) || return 1
	now=$(date +%s) || return 1
	age=$((now - mtime))
	[ "$age" -ge "-$MAX_FUTURE_S" ] && [ "$age" -le "$MAX_AGE_S" ]
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
