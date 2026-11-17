#!/bin/sh
# hooks/verify-update.sh — x-app.update.verify (App 2.0 / 3.0 / 4.0).
#
# Engine contract (Axle addendum, 2026-11-15): once after Health, via
#   docker compose exec -T -u 33 /idea/hooks/verify-update.sh
# on the running nextcloud-app. Exit 0 passes. Any other exit is VERIFY_FAILED
# and rolls the hop back, like a Health failure. Runs once; there is no poll.
#
# user: "33" is declared on the step (gaps 10 and 13 accepted). The Engine
# passes it verbatim as exec -u; it never defaults a step to 33. No in-script
# root→www-data fallback.
#
# Checks (all hard failures, no "not yet"):
#   status.php: installed true, maintenance false, needsDbUpgrade false
#   occ app:list Enabled: richdocuments at the pinned version OR NEWER (semver
#   compare, idea_version_ge in update-lib.sh), idea_usage enabled at its exact
#   version (unchanged)
# Expected versions come from update-lib.sh (tarball / IDEA_APP_VERSION table /
# env), so this script is shared across 2.0, 3.0 and 4.0.
#
# Test switch (engine#456 injected-failure runs, PR #505 Pi proof): when the file
#   /var/www/html/data/.idea-test-fail-verify
# exists (host: <instance>/data/nextcloud/data/.idea-test-fail-verify, the Nextcloud
# data dir, not served over HTTP), verify prints
#   ERROR: verify failed (test switch /var/www/html/data/.idea-test-fail-verify) [idea-verify-update]
# and exits 1 before any other check, so the Engine rolls the hop back (VERIFY_FAILED).
# A file, not env: the Engine passes only IDEA_UPDATE_FROM / IDEA_UPDATE_TO, and the
# data dir persists across Swap without editing compose. Create it on the 1.8 instance
# before updateApp (sudo touch; any owner/content). It is in the pre-update snapshot, so
# it survives the rollback: remove it before the next (happy-path) run.
# IDEA_TEST_FAIL_VERIFY_MARKER overrides the path (unit tests only).
#
# Env: IDEA_NC_HEALTH_URL, OCC, IDEA_BUNDLED_APPS, IDEA_APP_VERSION,
#      IDEA_VERIFY_RICHDOCUMENTS_VERSION, IDEA_VERIFY_IDEA_USAGE_VERSION,
#      IDEA_UPDATE_TARGETS
set -eu

HOOKS_DIR=$(dirname "$0")
IDEA_UPDATE_LOG_PREFIX=idea-verify-update
# shellcheck disable=SC1091
. "$HOOKS_DIR/update-lib.sh"

idea_install_traps
idea_refuse_argv "$@"
idea_log_hop

# Injected-failure test switch (see header). Checked first, so the result never
# depends on the instance state.
test_marker=${IDEA_TEST_FAIL_VERIFY_MARKER:-/var/www/html/data/.idea-test-fail-verify}
if [ -e "$test_marker" ]; then
	idea_die "verify failed (test switch $test_marker)"
fi

idea_load_target_versions

# status.php URL: IDEA_NC_HEALTH_URL (default http://127.0.0.1/status.php), read by idea_fetch_status.

body=
idea_mktemp body idea-verify || idea_die "cannot create temp file"

if ! code=$(idea_fetch_status "$body"); then
	idea_die "status.php unreachable"
fi
[ "$code" = 200 ] || idea_die "status.php HTTP $code"

if ! idea_status_has "$body" '"installed"[[:space:]]*:[[:space:]]*true'; then
	idea_die "status.php installed is not true"
fi
if ! idea_status_has "$body" '"maintenance"[[:space:]]*:[[:space:]]*false'; then
	idea_die "status.php maintenance is not false"
fi
if ! idea_status_has "$body" '"needsDbUpgrade"[[:space:]]*:[[:space:]]*false'; then
	idea_die "status.php needsDbUpgrade is not false"
fi

if ! list=$(idea_run_occ app:list); then
	idea_die "occ app:list failed"
fi

# Only the Enabled: block (up to Disabled: or end of output).
enabled=$(printf '%s\n' "$list" | sed -n '/^Enabled:/,/^Disabled:/p')
[ -n "$enabled" ] || idea_die "occ app:list had no Enabled: section"

# richdocuments: the pinned (bundled) version or newer, by semver compare
# (Steve's decision 2026-11-16). prepare pins appstoreenabled=false, so newer
# should not happen; if the app store still moved it forward, that is accepted
# rather than rolled back. Older, missing or disabled fails.
rd_have=$(printf '%s\n' "$enabled" | sed -n 's/^  - richdocuments: \([^[:space:]]*\)[[:space:]]*$/\1/p' | head -n 1)
[ -n "$rd_have" ] || idea_die "richdocuments >= ${IDEA_RD_VER} is not enabled (occ app:list)"
rd_cmp=0
idea_version_ge "$rd_have" "$IDEA_RD_VER" || rd_cmp=$?
case "$rd_cmp" in
	0) ;;
	1) idea_die "richdocuments ${rd_have} is older than the pinned ${IDEA_RD_VER} (occ app:list)" ;;
	*) idea_die "richdocuments version '${rd_have}' or pin '${IDEA_RD_VER}' is not a version" ;;
esac
if [ "$rd_have" != "$IDEA_RD_VER" ]; then
	idea_log "richdocuments ${rd_have} is newer than the pinned ${IDEA_RD_VER}; accepted (>= rule)"
fi
printf '%s\n' "$enabled" | grep -Eq "^  - idea_usage:" \
	|| idea_die "idea_usage is not enabled (occ app:list)"
# idea_usage version is checked when we know it (shipped 1.0.0 on every hop).
if [ -n "$IDEA_USAGE_VER" ]; then
	printf '%s\n' "$enabled" | grep -Fxq "  - idea_usage: ${IDEA_USAGE_VER}" \
		|| idea_die "idea_usage ${IDEA_USAGE_VER} is not enabled (occ app:list)"
fi

idea_log "verified (richdocuments ${rd_have} >= ${IDEA_RD_VER}, idea_usage ${IDEA_USAGE_VER} enabled)"
exit 0
