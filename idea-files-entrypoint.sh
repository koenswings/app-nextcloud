#!/bin/sh
# idea-files-entrypoint.sh — root wrapper for Nextcloud Files Disk mounts (idea#137)
#
# Runs as container root (compose entrypoint). For each top-level directory under
# /mnt/idea-files, chown to uid 33 (www-data) only when the owner is wrong, and
# never recursively. Then exec the image's normal /entrypoint.sh.
#
# Never touches Nextcloud's own data under instances/<id>/data. No special case
# for Nextcloud on a combined App+Files disk — only /mnt/idea-files/* matters.
#
# Env (tests may override):
#   IDEA_FILES_ROOT   default /mnt/idea-files
#   WWW_DATA_UID      default 33
#   IDEA_ENTRYPOINT   default /entrypoint.sh
set -eu

IDEA_FILES_ROOT="${IDEA_FILES_ROOT:-/mnt/idea-files}"
WWW_DATA_UID="${WWW_DATA_UID:-33}"
IDEA_ENTRYPOINT="${IDEA_ENTRYPOINT:-/entrypoint.sh}"

if [ -d "$IDEA_FILES_ROOT" ]; then
	# Only top-level directories; skip files (e.g. .idea-files.json).
	# A bare glob with no matches must not abort under set -eu.
	for dir in "$IDEA_FILES_ROOT"/*; do
		[ -e "$dir" ] || continue
		[ -d "$dir" ] || continue
		# owner uid only (not recursive)
		owner="$(stat -c '%u' "$dir" 2>/dev/null || stat -f '%u' "$dir")"
		if [ "$owner" != "$WWW_DATA_UID" ]; then
			chown "${WWW_DATA_UID}:${WWW_DATA_UID}" "$dir"
		fi
	done
fi

exec "$IDEA_ENTRYPOINT" "$@"
