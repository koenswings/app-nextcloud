#!/bin/sh
# hooks/app-healthcheck.sh — Docker healthcheck for nextcloud-app (app-nextcloud#29).
#
# Alive when:
#   - status.php returns HTTP 200 and the body contains
#     "maintenance":false,"needsDbUpgrade":false  (normal ready state), or
#   - status.php returns HTTP 503, the body contains "maintenance":true, and
#     the IDEA backup marker exists (written at the start of backup-db-dump.sh,
#     removed by backup-db-clean.sh).
# Everything else fails (down, a stuck or manual maintenance window, an upgrade
# still in maintenance after start_period). Quiet: no output on success or failure.
# x-app.healthCheck in compose.yaml stays stricter; updateApp's Health step uses that.
set -eu

URL="${IDEA_NC_HEALTH_URL:-http://127.0.0.1/status.php}"
MARKER="${IDEA_BACKUP_MARKER:-/idea-backup-db/.idea-backup-pending}"

tmp=$(mktemp) || exit 1
trap 'rm -f "$tmp"' EXIT

code=$(curl -sS -m 4 -o "$tmp" -w '%{http_code}' "$URL") || exit 1

if [ "$code" = 200 ] && grep -q '"maintenance":false,"needsDbUpgrade":false' "$tmp"; then
	exit 0
fi
if [ "$code" = 503 ] && grep -q '"maintenance":true' "$tmp" && [ -f "$MARKER" ]; then
	exit 0
fi
exit 1
