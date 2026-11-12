#!/bin/sh
# 05-idea-skeleton-config.sh — put config/idea-skeleton.config.php into
# Nextcloud's config dir (idea#464).
#
# Runs as www-data from the official image hooks:
#   pre-installation/05-idea-skeleton-config.sh  (fresh install: after the
#     image has copied its stock config/ files, BEFORE occ maintenance:install,
#     so the install-time admin's first-login skeleton copy is already empty)
#   before-starting/05-idea-skeleton-config.sh   (symlink; every later start,
#     so existing installs get the file on updateApp / restart)
#
# Nextcloud merges config/*.config.php over config.php. The file is only
# copied when missing or different, so a restart is a no-op.
# 26-idea-skeleton.sh (occ config:system:set) stays as a fallback for a
# start without the ./config bind.
#
# Fail open: always exits 0 so Nextcloud starts even when the copy fails.
# Env (tests): IDEA_CONFIG_SRC (default /idea-config),
#              IDEA_NC_CONFIG_DIR (default /var/www/html/config)
set -u
log() { echo "idea-skeleton-config: $*"; }

NAME=idea-skeleton.config.php
SRC="${IDEA_CONFIG_SRC:-/idea-config}/$NAME"
DST_DIR="${IDEA_NC_CONFIG_DIR:-/var/www/html/config}"
DST="$DST_DIR/$NAME"

if [ ! -f "$SRC" ]; then
	log "WARNING $SRC missing — skip (26-idea-skeleton.sh still sets the keys after install)"
	exit 0
fi
if [ ! -d "$DST_DIR" ]; then
	log "WARNING $DST_DIR missing — skip"
	exit 0
fi
if [ -f "$DST" ] && cmp -s "$SRC" "$DST"; then
	log "already in place"
	exit 0
fi
TMP="$DST_DIR/.$NAME.tmp.$$"
if cp "$SRC" "$TMP" 2>/dev/null && chmod 0640 "$TMP" 2>/dev/null && mv -f "$TMP" "$DST" 2>/dev/null; then
	log "installed $NAME (skeletondirectory and templatedirectory empty)"
else
	[ -f "$TMP" ] && mv -f "$TMP" "$DST_DIR/.$NAME.failed" 2>/dev/null
	log "WARNING could not install $DST"
fi
exit 0
