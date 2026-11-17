#!/bin/sh
# hooks/settle-update.sh — x-app.update.settle (App 2.0 / 3.0 / 4.0).
#
# Engine contract (Axle addendum, 2026-11-15): after work, via
#   docker compose exec -T -u 33 /idea/hooks/settle-update.sh
# on the running nextcloud-app, polled every `interval` until `timeout`.
# Exit 0 = settled, 3 = not yet (poll again), any other exit is an error.
# A settle error or timeout is not a rollback; the path stops with
# migrationsPending (Engine stopReason). This script is a read-only probe
# and does not run cron.php (work does that).
#
# user: "33" is declared on the step (gaps 10 and 13 accepted). No in-script
# root→www-data fallback.
#
# Read-only checks:
#   status.php: installed true (ERROR if not), maintenance false and
#   needsDbUpgrade false ("not yet" if not). Then a read-only upgrade-job
#   probe. Pending jobs → "not yet". Probe unavailable → rely on status.php
#   (the work step already ran the documented cron.php series).
# App version / enabled checks live in verify (they roll back), not here.
#
# Makes no writes at all (gap 8). The app store pin from prepare is restored by
# work (Steve's S4 decision, 2026-11-16), not here.
#
# Env: IDEA_NC_HEALTH_URL, OCC, IDEA_PENDING_JOB_PATTERN
set -eu

HOOKS_DIR=$(dirname "$0")
IDEA_UPDATE_LOG_PREFIX=idea-settle-update
# shellcheck disable=SC1091
. "$HOOKS_DIR/update-lib.sh"

idea_install_traps
idea_refuse_argv "$@"
idea_log_hop

body=
idea_mktemp body idea-settle || idea_die "cannot create temp file"

if ! code=$(idea_fetch_status "$body"); then
	idea_not_yet "status.php unreachable"
fi
[ "$code" = 200 ] || idea_not_yet "status.php HTTP $code"

if ! idea_status_has "$body" '"installed"[[:space:]]*:[[:space:]]*true'; then
	idea_die "status.php installed is not true"
fi
if ! idea_status_has "$body" '"maintenance"[[:space:]]*:[[:space:]]*false'; then
	idea_not_yet "status.php maintenance is not false"
fi
if ! idea_status_has "$body" '"needsDbUpgrade"[[:space:]]*:[[:space:]]*false'; then
	idea_not_yet "status.php needsDbUpgrade is not false"
fi

jobs_status=0
matches=$(idea_list_upgrade_jobs) || jobs_status=$?
if [ "$jobs_status" -eq 0 ]; then
	idea_not_yet "upgrade jobs still pending"
fi
if [ "$jobs_status" -eq 2 ]; then
	idea_log "upgrade-job probe unavailable (occ background-job:list); relying on status.php"
elif [ "$jobs_status" -eq 3 ]; then
	idea_not_yet "upgrade-job probe failed"
fi

idea_log "settled"
exit 0
