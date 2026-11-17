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
# Error and pending lines START with "ERROR:" / "not yet:" (engine#456: the
# Engine matches them only at the start of a line, after leading whitespace,
# and keeps the last one, capped at 200 characters). The script name goes at
# the end of the line in brackets. Info lines are "<script>: ...".
# Scripts must not print secrets.
#
# TERM-safe (engine#456: on a step timeout the Engine sends SIGTERM to the
# in-container pid, then SIGKILL after 10 s). idea_install_traps sets an EXIT
# trap that removes this script's temp files (idea_mktemp) and TERM/INT/HUP
# traps that also stop a child started with idea_run, print one ERROR: line
# and exit 128+signal. Long commands (occ repairs, cron.php) run through
# idea_run so the trap fires at once instead of after the child. Temp files are
# only ever created through idea_mktemp in the main shell (never inside $(...),
# whose traps are reset). Nothing here writes config.php directly; occ does.

idea_log() { echo "${IDEA_UPDATE_LOG_PREFIX:-idea-update}: $*"; }
idea_die() { echo "ERROR: $* [${IDEA_UPDATE_LOG_PREFIX:-idea-update}]"; exit 1; }
idea_not_yet() { echo "not yet: $* [${IDEA_UPDATE_LOG_PREFIX:-idea-update}]"; exit 3; }

IDEA_TMP_FILES=
IDEA_CHILD=
# idea_mktemp VAR NAME: create a temp file, register it for cleanup, set VAR.
idea_mktemp() {
	_idea_f=$(mktemp "${TMPDIR:-/tmp}/$2.XXXXXX") || return 1
	IDEA_TMP_FILES="$IDEA_TMP_FILES $_idea_f"
	eval "$1=\$_idea_f"
}
idea_cleanup() {
	for _idea_f in $IDEA_TMP_FILES; do rm -f "$_idea_f"; done
	IDEA_TMP_FILES=
}
idea_on_signal() {
	trap - EXIT
	if [ -n "$IDEA_CHILD" ]; then
		kill -TERM "$IDEA_CHILD" 2>/dev/null || :
	fi
	idea_cleanup
	echo "ERROR: interrupted by SIG$1 [${IDEA_UPDATE_LOG_PREFIX:-idea-update}]"
	exit "$2"
}
idea_install_traps() {
	trap idea_cleanup EXIT
	trap 'idea_on_signal TERM 143' TERM
	trap 'idea_on_signal INT 130' INT
	trap 'idea_on_signal HUP 129' HUP
}
# idea_run CMD...: run a real command (not a shell function) in the background
# and wait, so a TERM is handled now and forwarded to it. stdin is /dev/null.
idea_run() {
	"$@" < /dev/null &
	IDEA_CHILD=$!
	_idea_st=0
	wait "$IDEA_CHILD" || _idea_st=$?
	IDEA_CHILD=
	return "$_idea_st"
}

# engine#456 design §8 Q7 (Steve, 2026-11-17; Axle's answer): the Engine
# passes IDEA_UPDATE_FROM / IDEA_UPDATE_TO, the old and new x-app.version
# (e.g. 1.8-31.0.14 -> 2.0-32.0.15), with -e on both compose run and exec.
# Non-secret. Logged for the trace only; no step depends on them (an Engine
# that does not set them, or a manual run, behaves the same).
idea_log_hop() {
	if [ -n "${IDEA_UPDATE_FROM:-}" ] || [ -n "${IDEA_UPDATE_TO:-}" ]; then
		idea_log "hop ${IDEA_UPDATE_FROM:-?} -> ${IDEA_UPDATE_TO:-?}"
	fi
}

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
	# No temp file: this runs inside $(...), where the cleanup traps do not apply.
	xml=$(tar -xOf "$tgz" "$app/appinfo/info.xml" 2>/dev/null) || return 1
	ver=$(printf '%s\n' "$xml" | sed -n 's|^[[:space:]]*<version>\([^<]*\)</version>.*|\1|p' | head -n 1)
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

# occ / cron.php through idea_run (TERM-forwarding), for the long work steps.
idea_run_occ_bg() {
	if [ -n "${OCC:-}" ]; then
		idea_run "$OCC" "$@"
		return
	fi
	idea_run php /var/www/html/occ "$@"
}
idea_run_cron_bg() {
	if [ -n "${IDEA_CRON:-}" ]; then
		idea_run "$IDEA_CRON"
		return
	fi
	idea_run php /var/www/html/cron.php
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
	# No temp files: callers run this inside $(...) (traps do not apply there).
	status=0
	combined=$(idea_run_occ background-job:list 2>&1) || status=$?
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

# Semantic-version compare (verify's "pinned version or newer" rule, Steve's
# decision 2026-11-16, Axle review §#456 L option (b)).
#   idea_version_ge HAVE WANT   return 0 if HAVE >= WANT, 1 if HAVE < WANT,
#                               2 if either is not a version.
# Rules (semver 2.0 precedence, extended to any number of numeric core parts):
#   - build metadata (+...) is ignored; a leading "v" is allowed;
#   - core parts compare numerically, missing parts count as 0 (9.2 == 9.2.0),
#     so 10.0.0 > 9.10.0 > 9.2.10 > 9.2.3 (never a string compare);
#   - equal cores: a release beats any pre-release (9.2.3 > 9.2.3-beta.1);
#     pre-release identifiers compare numerically when both are numeric,
#     otherwise in ASCII order, numeric < alphanumeric, shorter list first.
idea_version_ge() {
	awk -v a="$1" -v b="$2" '
		function prep(v, parts,   core, pre, i, n, c) {
			sub(/^[vV]/, "", v)
			sub(/\+.*$/, "", v)
			pre = ""
			i = index(v, "-")
			if (i > 0) { pre = substr(v, i + 1); v = substr(v, 1, i - 1); if (pre == "") return -1 }
			if (v !~ /^[0-9]+(\.[0-9]+)*$/) return -1
			if (pre != "" && pre !~ /^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/) return -1
			n = split(v, c, ".")
			parts["n"] = n
			for (i = 1; i <= n; i++) parts[i] = c[i] + 0
			parts["pre"] = pre
			return 0
		}
		function cmpid(x, y,   xn, yn) {
			xn = (x ~ /^[0-9]+$/); yn = (y ~ /^[0-9]+$/)
			if (xn && yn) { x += 0; y += 0; return x < y ? -1 : (x > y ? 1 : 0) }
			if (xn) return -1
			if (yn) return 1
			return x < y ? -1 : (x > y ? 1 : 0)
		}
		BEGIN {
			if (prep(a, A) < 0 || prep(b, B) < 0) exit 2
			n = A["n"] > B["n"] ? A["n"] : B["n"]
			for (i = 1; i <= n; i++) {
				x = (i <= A["n"]) ? A[i] : 0
				y = (i <= B["n"]) ? B[i] : 0
				if (x > y) exit 0
				if (x < y) exit 1
			}
			if (A["pre"] == B["pre"]) exit 0
			if (A["pre"] == "") exit 0
			if (B["pre"] == "") exit 1
			na = split(A["pre"], pa, "."); nb = split(B["pre"], pb, ".")
			for (i = 1; i <= na && i <= nb; i++) {
				c = cmpid(pa[i], pb[i])
				if (c > 0) exit 0
				if (c < 0) exit 1
			}
			exit (na >= nb) ? 0 : 1
		}
	'
}

# App store pin restore (Steve's decision 2026-11-16, Axle review §#456 L (a)).
# prepare (hooks/appstore-pin.php) pinned appstoreenabled=false and recorded the
# previous value in the state file below; work (work-update.sh) calls this
# first, right after verify, with the DB up and as user 33, so plain occ works:
#   previous=unset        -> occ config:system:delete appstoreenabled
#   previous=bool:<v>     -> occ config:system:set appstoreenabled --value=<v> --type=boolean
#   previous=int:<n>      -> ... --value=<n> --type=integer
#   previous=string:<b64> -> ... --value=<decoded> --type=string
# Then the state file is removed. No state file: nothing was pinned (prepare did
# not run, e.g. an Engine that ignores stages, or the value was already restored),
# so appstoreenabled is left alone. Idempotent: occ set/delete can be repeated,
# and the file is removed only after occ succeeded, so a retry (Resume after
# migrationsPending re-runs work) restores again. A failure is an ERROR, which
# in work means migrationsPending: no rollback, the path stops and Resume retries.
# Env: IDEA_UPDATE_STATE_DIR (default /var/www/html/custom_apps/.idea-update-state)
idea_appstore_state_file() {
	printf '%s/appstoreenabled.state' "${IDEA_UPDATE_STATE_DIR:-/var/www/html/custom_apps/.idea-update-state}"
}

idea_appstore_restore() {
	state=$(idea_appstore_state_file)
	if [ ! -e "$state" ]; then
		idea_log "app store pin: no state file, appstoreenabled left as is"
		return 0
	fi
	prev=$(sed -n 's/^previous=//p' "$state" | head -n 1)
	case "$prev" in
		unset)
			idea_run_occ config:system:delete appstoreenabled >/dev/null \
				|| idea_die "occ config:system:delete appstoreenabled failed (app store stays pinned off)"
			;;
		bool:true|bool:false)
			idea_run_occ config:system:set appstoreenabled --value="${prev#bool:}" --type=boolean >/dev/null \
				|| idea_die "occ config:system:set appstoreenabled ${prev#bool:} failed (app store stays pinned off)"
			;;
		int:*)
			n=${prev#int:}
			case "$n" in
				''|-|*[!0-9-]*|?*-*) idea_die "app store pin state has a bad integer: $prev" ;;
			esac
			idea_run_occ config:system:set appstoreenabled --value="$n" --type=integer >/dev/null \
				|| idea_die "occ config:system:set appstoreenabled $n failed (app store stays pinned off)"
			;;
		string:*)
			if ! s=$(printf '%s' "${prev#string:}" | base64 -d 2>/dev/null); then
				idea_die "app store pin state has bad base64: $prev"
			fi
			idea_run_occ config:system:set appstoreenabled --value="$s" --type=string >/dev/null \
				|| idea_die "occ config:system:set appstoreenabled (string) failed (app store stays pinned off)"
			;;
		*)
			idea_die "app store pin state $state has no valid previous= line (got '${prev}')"
			;;
	esac
	rm -f "$state" || idea_die "cannot remove $state after restoring appstoreenabled"
	case "$prev" in string:*) shown=string ;; *) shown=$prev ;; esac
	idea_log "app store pin: restored appstoreenabled (previous=${shown}) and removed the state file"
}
