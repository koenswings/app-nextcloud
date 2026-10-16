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
#   IDEA_COLLABORA_PROXY  e.g. http://code:9980: proxy Office (CODE) through this Apache so CODE
#                     needs no host port (one CODE per instance). Empty = no proxy.
#   IDEA_APACHE_DIR   default /etc/apache2;  IDEA_A2ENMOD default a2enmod (tests override)
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

# Office proxy (idempotent: the container keeps its filesystem across stop/start).
collabora_proxy() {
	target="${IDEA_COLLABORA_PROXY:-}"
	apache="${IDEA_APACHE_DIR:-/etc/apache2}"
	conf="$apache/idea-collabora.conf"
	site="$apache/sites-enabled/000-default.conf"
	case "$target" in http://*|https://*) ;; *) return 0 ;; esac
	ws="ws://${target#http://}"
	case "$target" in https://*) ws="wss://${target#https://}" ;; esac
	${IDEA_A2ENMOD:-a2enmod} -q proxy proxy_http proxy_wstunnel >/dev/null 2>&1 || echo "idea-collabora: WARNING a2enmod failed"
	cat > "$conf" <<EOF
# Written by idea-files-entrypoint.sh: Nextcloud Office (CODE) through this Nextcloud.
AllowEncodedSlashes NoDecode
ProxyPreserveHost On
ProxyPass           /browser $target/browser retry=0
ProxyPassReverse    /browser $target/browser
ProxyPass           /hosting/discovery $target/hosting/discovery retry=0
ProxyPassReverse    /hosting/discovery $target/hosting/discovery
ProxyPass           /hosting/capabilities $target/hosting/capabilities retry=0
ProxyPassReverse    /hosting/capabilities $target/hosting/capabilities
ProxyPassMatch      "/cool/(.*)/ws\$" $ws/cool/\$1/ws nocanon
ProxyPass           /cool/adminws $ws/cool/adminws
ProxyPass           /cool $target/cool
ProxyPassReverse    /cool $target/cool
EOF
	if [ -f "$site" ] && ! grep -q 'idea-collabora.conf' "$site"; then
		sed -i "s#</VirtualHost>#\tInclude $conf\n</VirtualHost>#" "$site"
	fi
	echo "idea-collabora: Office proxied to $target"
}
collabora_proxy || echo "idea-collabora: WARNING proxy setup failed (Office may not open)"

# Compose entrypoint override drops image CMD; default like the official image.
if [ "$#" -eq 0 ]; then
	set -- apache2-foreground
fi
exec "$IDEA_ENTRYPOINT" "$@"
