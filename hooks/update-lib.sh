#!/bin/sh
# hooks/update-lib.sh — shared helpers for x-app.update verify / work / settle.
# Sourced, not executed. Set IDEA_UPDATE_LOG_PREFIX before sourcing.
#
# Target versions (first match wins per app):
#   1. IDEA_VERIFY_RICHDOCUMENTS_VERSION / IDEA_VERIFY_IDEA_USAGE_VERSION (tests)
#   2. <version> inside the bundled tarball at IDEA_BUNDLED_APPS (default
#      /idea-bundled-apps), so one script serves 2.0 / 3.0 / 4.0
#   3. hooks/update-targets keyed by IDEA_APP_VERSION (compose x-app.version)
#
# The Engine addendum accepts `user` and passes it verbatim as run --user /
# exec -u. Compose declares user: "33" on verify, work and settle, so occ and
# cron.php are not invoked as root. This lib has no root→www-data fallback.
#
# Error lines use the prefixes the Engine captures: "ERROR:" and "not yet:"
# (capped at 200 characters on the Engine side). Scripts must not print secrets.

idea_log() { echo "${IDEA_UPDATE_LOG_PREFIX:-idea-update}: $*"; }
idea_die() { idea_log "ERROR: $*"; exit 1; }
idea_not_yet() { idea_log "not yet: $*"; exit 3; }

# Gap 2 accepted: the Engine overrides entrypoint to [command] with an empty
# command. Apps must not rely on ignoring leftover argv (apache2-foreground).
idea_refuse_argv() {
	if [ "$#" -ne 0 ]; then
		idea_die "unexpected arguments: $* (Engine must pass an empty command)"
	fi
}

idea_xml_version() { sed -n 's|^[[:space:]]*<version>\([^<]*\)</version>.*|\1|p' "$1" | head -n 1; }

idea_xml_max() { tr '\n' ' ' < "$1" | sed -n 's/.*<nextcloud[^>]*max-version="\([^"]*\)".*/\1/p' | head -n 1; }

idea_version_from_tarball() {
	app="$1"
	src="${IDEA_BUNDLED_APPS:-/idea-bundled-apps}"
	tgz=
	for f in "$src/$app"-v*.tar.gz; do
		[ -f "$f" ] || continue
		tgz=$f
		break
	done
	[ -n "$tgz" ] || return 1
	tmp=$(mktemp "${TMPDIR:-/tmp}/idea-target-$app.XXXXXX") || return 1
	if ! tar -xOf "$tgz" "$app/appinfo/info.xml" > "$tmp" 2>/dev/null; then
		rm -f "$tmp"
		return 1
	fi
	ver=$(idea_xml_version "$tmp")
	rm -f "$tmp"
	[ -n "$ver" ] || return 1
	printf '%s' "$ver"
}

idea_version_from_table() {
	app="$1"
	col="$2"
	ver="${IDEA_APP_VERSION:-}"
	table="${IDEA_UPDATE_TARGETS:-${HOOKS_DIR:-.}/update-targets}"
	[ -n "$ver" ] || return 1
	[ -f "$table" ] || return 1
	awk -v ver="$ver" -v col="$col" '
		$1 ~ /^#/ { next }
		NF < 3 { next }
		$1 == ver { print $col; found=1; exit }
		END { exit found ? 0 : 1 }
	' "$table"
}

# Sets IDEA_RD_VER and IDEA_USAGE_VER.
idea_load_target_versions() {
	if [ -n "${IDEA_VERIFY_RICHDOCUMENTS_VERSION:-}" ]; then
		IDEA_RD_VER=$IDEA_VERIFY_RICHDOCUMENTS_VERSION
	else
		IDEA_RD_VER=$(idea_version_from_tarball richdocuments) || IDEA_RD_VER=$(idea_version_from_table richdocuments 2) || IDEA_RD_VER=
	fi
	if [ -n "${IDEA_VERIFY_IDEA_USAGE_VERSION:-}" ]; then
		IDEA_USAGE_VER=$IDEA_VERIFY_IDEA_USAGE_VERSION
	else
		IDEA_USAGE_VER=$(idea_version_from_tarball idea_usage) || IDEA_USAGE_VER=$(idea_version_from_table idea_usage 3) || IDEA_USAGE_VER=
	fi
	[ -n "$IDEA_RD_VER" ] || idea_die "cannot determine richdocuments target version (set IDEA_VERIFY_RICHDOCUMENTS_VERSION, ship a tarball, or add IDEA_APP_VERSION to update-targets)"
	[ -n "$IDEA_USAGE_VER" ] || idea_die "cannot determine idea_usage target version (set IDEA_VERIFY_IDEA_USAGE_VERSION, ship a tarball, or add IDEA_APP_VERSION to update-targets)"
}

# occ as the current user. Engine declares user: "33"; no root fallback.
idea_run_occ() {
	if [ -n "${OCC:-}" ]; then
		"$OCC" "$@"
		return
	fi
	php /var/www/html/occ "$@"
}

idea_run_cron() {
	if [ -n "${IDEA_CRON:-}" ]; then
		"$IDEA_CRON"
		return
	fi
	php /var/www/html/cron.php
}

# Fetch status.php into $1; print HTTP code to stdout. Curl failure: return 1.
idea_fetch_status() {
	dest="$1"
	url="${IDEA_NC_HEALTH_URL:-http://127.0.0.1/status.php}"
	code=$(curl -sS -m 5 -o "$dest" -w '%{http_code}' "$url") || return 1
	printf '%s' "$code"
	return 0
}

idea_status_has() {
	grep -Eq "$2" "$1"
}

# Read-only probe for upgrade-related background jobs still queued after a major.
# Prints matching lines. Return:
#   0  one or more pending upgrade jobs
#   1  probe ran, none pending
#   2  probe unavailable (unknown occ command) — caller falls back
#   3  probe failed for another reason
#
# Command and class filter are desk-based (Nextcloud documents running cron.php
# 2-3 times, not a public job query). Confirm on a pool Pi. Pattern override:
# IDEA_PENDING_JOB_PATTERN. Missing-command fallback is intentional.
idea_list_upgrade_jobs() {
	pattern="${IDEA_PENDING_JOB_PATTERN:-Migration|BackgroundRepair|RepairJob}"
	out=$(mktemp "${TMPDIR:-/tmp}/idea-jobs.XXXXXX") || return 3
	err=$(mktemp "${TMPDIR:-/tmp}/idea-jobs-err.XXXXXX") || { rm -f "$out"; return 3; }
	status=0
	idea_run_occ background-job:list > "$out" 2>"$err" || status=$?
	combined=$(cat "$out" "$err")
	rm -f "$out" "$err"
	if [ "$status" -ne 0 ]; then
		if printf '%s\n' "$combined" | grep -Eqi 'not defined|unknown command|Command "[^"]+" is not defined|There are no commands defined'; then
			return 2
		fi
		return 3
	fi
	matches=$(printf '%s\n' "$combined" | grep -E "$pattern" || true)
	if [ -n "$matches" ]; then
		printf '%s\n' "$matches"
		return 0
	fi
	return 1
}
