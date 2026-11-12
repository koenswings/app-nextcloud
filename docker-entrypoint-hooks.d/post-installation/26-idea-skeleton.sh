#!/bin/sh
# 26-idea-skeleton.sh — empty the Nextcloud skeleton and template directories
# so a new user's first login copies no example files (idea#464, Steve's call).
#
# Stock Nextcloud 31 copies core/skeleton into a new user's home on first
# login (about 17 example files on this image). Those created_self office
# documents inflate documents.created. templatedirectory is separate: if only
# skeletondirectory is emptied, shipped templates are still copied into the
# new account. NC 31.0.1 config.sample.php: set both to empty strings to
# disable the copies and automatic template-folder creation.
#
# Runs as www-data from the official image hooks:
#   post-installation/26-idea-skeleton.sh  (fresh install only, after
#     maintenance:install; the official entrypoint does not re-run this
#     folder on a restart, updateApp, or core upgrade)
#   before-starting/26-idea-skeleton.sh    (symlink; every later start, so
#     existing installs get the setting on updateApp / restart, and also
#     after a Nextcloud core upgrade, which runs post-upgrade then this)
#
# The setting only affects first login of users who have not yet received a
# skeleton. Existing users' files are never touched, and already-counted
# documents.created rows stay as they are. Applying it on an existing
# install is therefore harmless.
#
# Fail open: always exits 0 so Nextcloud starts even when a set fails.
# Env: OCC (occ-compatible binary for tests)
set -u

run_occ() { if [ -n "${OCC:-}" ]; then "$OCC" "$@"; else php occ "$@"; fi; }
log() { echo "idea-skeleton: $*"; }

if ! run_occ status 2>/dev/null | grep -q 'installed: true'; then
	log "Nextcloud not installed yet — skip"
	exit 0
fi

# Unset means the NC 31 default (core/skeleton / shipped templates), not
# empty. Only skip when get succeeds and the value is already empty.
set_empty() {
	if cur="$(run_occ config:system:get "$1" 2>/dev/null)"; then
		[ -z "$cur" ] && return 0
	fi
	if run_occ config:system:set "$1" --type=string --value='' >/dev/null 2>&1; then
		log "set $1= (empty)"
	else
		log "WARNING could not set $1"
	fi
}

set_empty skeletondirectory
set_empty templatedirectory
exit 0
