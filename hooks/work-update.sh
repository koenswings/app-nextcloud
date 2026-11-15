#!/bin/sh
# hooks/work-update.sh — x-app.update.work (App 2.0 / 3.0 / 4.0).
#
# Engine contract (Axle addendum, 2026-11-15): once after verify and before
# settle, via
#   docker compose exec -T -u 33 /idea/hooks/work-update.sh
# on the running nextcloud-app. A non-zero exit or a timeout leaves the new
# major in place and stops the path with migrationsPending (no rollback).
#
# user: "33" is declared on the step (gaps 10 and 13 accepted). No in-script
# root→www-data fallback.
#
# Nextcloud documents that after a major, some migrations run as background
# jobs, and you should run cron.php 2-3 times before the next major. This
# script runs php /var/www/html/cron.php up to IDEA_WORK_CRON_RUNS times
# (default 3), and stops early once a read-only upgrade-job probe is clear.
# Idempotent: a later run just invokes cron.php again.
#
# If the job probe is unavailable (occ background-job:list not present — the
# exact command is UNCONFIRMED pending a Pi check), the documented 2-3 cron
# runs still happen and a successful series is exit 0.
# If jobs remain after the last run, exit 3 with a "not yet:" line.
# A cron.php failure is "ERROR:" and exit 1.
#
# Env: OCC, IDEA_CRON, IDEA_WORK_CRON_RUNS, IDEA_PENDING_JOB_PATTERN
set -eu

HOOKS_DIR=$(dirname "$0")
IDEA_UPDATE_LOG_PREFIX=idea-work-update
# shellcheck disable=SC1091
. "$HOOKS_DIR/update-lib.sh"

idea_refuse_argv "$@"

max=${IDEA_WORK_CRON_RUNS:-3}
case "$max" in
	''|*[!0-9]*|0) idea_die "IDEA_WORK_CRON_RUNS must be a positive integer (got ${max})" ;;
esac

run=1
while [ "$run" -le "$max" ]; do
	idea_log "cron.php run $run of $max"
	if ! idea_run_cron; then
		idea_die "cron.php failed on run $run of $max"
	fi
	jobs_status=0
	matches=$(idea_list_upgrade_jobs) || jobs_status=$?
	if [ "$jobs_status" -eq 1 ]; then
		idea_log "no pending upgrade jobs after cron.php run $run"
		idea_log "work done"
		exit 0
	fi
	if [ "$jobs_status" -eq 2 ]; then
		idea_log "upgrade-job probe unavailable (occ background-job:list); continuing documented cron.php runs"
		# Keep going until max, then treat success as done (no confirmed probe).
		if [ "$run" -eq "$max" ]; then
			idea_log "completed $max cron.php run(s) without a job probe; treating work as done"
			idea_log "work done"
			exit 0
		fi
	elif [ "$jobs_status" -eq 0 ]; then
		idea_log "upgrade jobs still pending after cron.php run $run"
	else
		# Probe failed for another reason. Keep trying until the last run,
		# then fail closed so the path stops with migrationsPending rather
		# than claiming the hop is settled.
		idea_log "upgrade-job probe failed after cron.php run $run"
		if [ "$run" -eq "$max" ]; then
			idea_not_yet "upgrade-job probe failed after $max cron.php run(s)"
		fi
	fi
	run=$((run + 1))
done

idea_not_yet "upgrade jobs still pending after $max cron.php run(s)"
