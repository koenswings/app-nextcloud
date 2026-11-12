#!/bin/sh
# 25-idea-usage.sh — enable the bundled IDEA usage counter (idea_usage).
# Runs as www-data from the official image hooks:
#   post-installation/25-idea-usage.sh  (first start, after 20-idea-bundled-apps)
#   before-starting/25-idea-usage.sh    (symlink; every start, so existing installs get it)
# Fail open: always exits 0 so Nextcloud starts even when the counter cannot be enabled.
# Env: OCC (occ-compatible binary for tests), IDEA_CUSTOM_APPS (default /var/www/html/custom_apps)
set -u

run_occ() { if [ -n "${OCC:-}" ]; then "$OCC" "$@"; else php occ "$@"; fi; }
log() { echo "idea-usage: $*"; }

if ! run_occ status 2>/dev/null | grep -q 'installed: true'; then
	log "Nextcloud not installed yet — skip"
	exit 0
fi

CUSTOM="${IDEA_CUSTOM_APPS:-/var/www/html/custom_apps}"
if [ ! -f "$CUSTOM/idea_usage/appinfo/info.xml" ]; then
	log "WARNING idea_usage not present in custom_apps — skip"
	exit 0
fi

if run_occ app:list --enabled 2>/dev/null | grep -q '^  - idea_usage:'; then
	log "already enabled"
	exit 0
fi

if run_occ app:enable idea_usage >/dev/null 2>&1; then
	log "enabled idea_usage"
else
	log "WARNING could not enable idea_usage"
fi
exit 0
