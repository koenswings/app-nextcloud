#!/bin/sh
# hooks/settle-update.sh — x-app.update.settle (App 2.0, Nextcloud 32).
#
# Engine contract (Axle): after Health passes, via docker compose exec on the
# running nextcloud-app. Exit 0 = settled, 3 = not yet (poll again), any other
# exit is an error. A settle error or timeout is not a rollback.
#
# Read-only: status.php (installed true, maintenance false, needsDbUpgrade false)
# plus occ app:list (richdocuments 9.2.3 and idea_usage 1.0.0 enabled). Does not
# run cron.php or any occ write (see /workspace/kid-nc35/contract-gaps.md).
#
# If this script is exec'd as root, occ is run as www-data (uid 33).
#
# Env:
#   IDEA_NC_HEALTH_URL                   default http://127.0.0.1/status.php
#   OCC                                  test double for occ (optional)
#   IDEA_SETTLE_RICHDOCUMENTS_VERSION    default 9.2.3
#   IDEA_SETTLE_IDEA_USAGE_VERSION       default 1.0.0
set -eu

log() { echo "idea-settle-update: $*"; }
not_yet() { log "not yet: $*"; exit 3; }
die() { log "ERROR: $*"; exit 1; }

URL="${IDEA_NC_HEALTH_URL:-http://127.0.0.1/status.php}"
RD_VER="${IDEA_SETTLE_RICHDOCUMENTS_VERSION:-9.2.3}"
USAGE_VER="${IDEA_SETTLE_IDEA_USAGE_VERSION:-1.0.0}"

run_occ() {
	if [ -n "${OCC:-}" ]; then
		"$OCC" "$@"
		return
	fi
	if [ "$(id -u)" != 0 ]; then
		php /var/www/html/occ "$@"
		return
	fi
	if command -v runuser >/dev/null 2>&1; then
		runuser -u www-data -- php /var/www/html/occ "$@"
	else
		su -s /bin/sh -c 'php /var/www/html/occ "$@"' www-data -- "$@"
	fi
}

body=$(mktemp "${TMPDIR:-/tmp}/idea-settle.XXXXXX") || die "cannot create temp file"
# shellcheck disable=SC2064
trap 'rm -f "$body"' EXIT

if ! code=$(curl -sS -m 5 -o "$body" -w '%{http_code}' "$URL"); then
	not_yet "status.php unreachable"
fi
[ "$code" = 200 ] || not_yet "status.php HTTP $code"

# Nextcloud's status.php is compact JSON; accept optional whitespace too.
has() { grep -Eq "$1" "$body"; }
if ! has '"installed"[[:space:]]*:[[:space:]]*true'; then
	die "status.php installed is not true"
fi
if ! has '"maintenance"[[:space:]]*:[[:space:]]*false'; then
	not_yet "status.php maintenance is not false"
fi
if ! has '"needsDbUpgrade"[[:space:]]*:[[:space:]]*false'; then
	not_yet "status.php needsDbUpgrade is not false"
fi

if ! list=$(run_occ app:list); then
	not_yet "occ app:list failed"
fi

# Only the Enabled: block (up to Disabled: or end of output).
enabled=$(printf '%s\n' "$list" | sed -n '/^Enabled:/,/^Disabled:/p')
[ -n "$enabled" ] || die "occ app:list had no Enabled: section"

printf '%s\n' "$enabled" | grep -Eq "^  - richdocuments: ${RD_VER}$" \
	|| die "richdocuments ${RD_VER} is not enabled (occ app:list)"
printf '%s\n' "$enabled" | grep -Eq "^  - idea_usage: ${USAGE_VER}$" \
	|| die "idea_usage ${USAGE_VER} is not enabled (occ app:list)"

log "settled (richdocuments ${RD_VER}, idea_usage ${USAGE_VER} enabled)"
exit 0
