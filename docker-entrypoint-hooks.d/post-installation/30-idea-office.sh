#!/bin/sh
# 30-idea-office.sh — connect Nextcloud Office (richdocuments) to the bundled CODE
# service. Runs as www-data from the official image hooks:
#   post-installation/30-idea-office.sh  (first start, right after maintenance:install)
#   before-starting/30-idea-office.sh    (symlink; every start, idempotent)
# Fail open: always exits 0 so Nextcloud starts even when Office can't be set up.
# Offline Pis can't download richdocuments from the app store; if the app code is
# not present the hook logs a warning and leaves Office unconfigured.
#
# Env:
#   IDEA_COLLABORA_URL  e.g. http://192.168.0.231:9980 (browser + server URL). Empty → skip.
#   OCC                 occ-compatible binary for tests (default: php occ)
set -u

run_occ() { if [ -n "${OCC:-}" ]; then "$OCC" "$@"; else php occ "$@"; fi; }
log() { echo "idea-office: $*"; }

URL="${IDEA_COLLABORA_URL:-}"
if [ -z "$URL" ]; then log "IDEA_COLLABORA_URL empty — skip"; exit 0; fi
case "$URL" in
	http://*|https://*) ;;
	*) log "IDEA_COLLABORA_URL '$URL' is not an http(s) URL — skip"; exit 0 ;;
esac

if ! run_occ status 2>/dev/null | grep -q 'installed: true'; then
	log "Nextcloud not installed yet — skip"
	exit 0
fi

# richdocuments: enable if present, else try one install (works only online).
if ! run_occ app:list --enabled 2>/dev/null | grep -q '^  - richdocuments:'; then
	if run_occ app:enable richdocuments >/dev/null 2>&1; then
		log "enabled richdocuments"
	elif run_occ app:install richdocuments >/dev/null 2>&1; then
		log "installed richdocuments"
	else
		log "WARNING richdocuments not available (offline?) — Office not configured"
		exit 0
	fi
fi

set_app() { # key value — write only when different
	cur="$(run_occ config:app:get richdocuments "$1" 2>/dev/null || true)"
	[ "$cur" = "$2" ] && return 0
	run_occ config:app:set richdocuments "$1" --value="$2" >/dev/null 2>&1 \
		&& log "set $1=$2" || log "WARNING could not set $1"
}
set_app wopi_url "$URL"
set_app public_wopi_url "$URL"
case "$URL" in http://*) set_app disable_certificate_verification yes ;; esac

# CODE runs on the LAN/Tailscale address; NC must be allowed to call it.
if [ "$(run_occ config:system:get allow_local_remote_servers 2>/dev/null || true)" != "true" ]; then
	run_occ config:system:set allow_local_remote_servers --type=boolean --value=true >/dev/null 2>&1 \
		&& log "set allow_local_remote_servers=true" || true
fi
log "done"
exit 0
