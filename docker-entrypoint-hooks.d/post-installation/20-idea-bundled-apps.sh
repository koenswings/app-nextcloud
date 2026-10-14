#!/bin/sh
# 20-idea-bundled-apps.sh — install Nextcloud apps shipped on the App Disk (offline Pis
# can't reach the app store). Runs as www-data:
#   post-installation/20-idea-bundled-apps.sh  (first start, before 30-idea-office)
#   before-starting/20-idea-bundled-apps.sh    (symlink; every start, so existing installs get it too)
# For each <app>-v<ver>.tar.gz in IDEA_BUNDLED_APPS whose sha256 matches SHA256SUMS, extract
# it into custom_apps/ when that app is not there yet. Never overwrites or downgrades an app
# an admin already installed/updated. Enabling is left to the app's own hook (30-idea-office).
# Fail open: always exits 0.
#
# Env: IDEA_BUNDLED_APPS (default /idea-bundled-apps), IDEA_CUSTOM_APPS (default /var/www/html/custom_apps)
set -u
SRC="${IDEA_BUNDLED_APPS:-/idea-bundled-apps}"
DST="${IDEA_CUSTOM_APPS:-/var/www/html/custom_apps}"
log() { echo "idea-bundled-apps: $*"; }

[ -d "$SRC" ] || { log "$SRC absent — skip"; exit 0; }
[ -d "$DST" ] || { log "$DST absent — skip"; exit 0; }
for tgz in "$SRC"/*.tar.gz; do
	[ -f "$tgz" ] || continue
	f="$(basename "$tgz")"; app="${f%%-v*}"
	if [ -e "$DST/$app" ]; then continue; fi
	want="$(awk -v f="$f" '$2==f {print $1}' "$SRC/SHA256SUMS" 2>/dev/null)"
	have="$(sha256sum "$tgz" 2>/dev/null | awk '{print $1}')"
	if [ -z "$want" ] || [ "$want" != "$have" ]; then
		log "WARNING $f checksum mismatch or not listed — skip"; continue
	fi
	tmp="$(mktemp -d "$DST/.idea-$app.XXXXXX")" || { log "WARNING cannot write $DST"; continue; }
	if tar -xzf "$tgz" -C "$tmp" && [ -f "$tmp/$app/appinfo/info.xml" ] && mv "$tmp/$app" "$DST/$app"; then
		log "installed $app from $f"
	else
		log "WARNING could not extract $f"
	fi
	rm -rf "$tmp"
done
exit 0
