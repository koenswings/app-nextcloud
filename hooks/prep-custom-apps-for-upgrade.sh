#!/bin/sh
# hooks/prep-custom-apps-for-upgrade.sh — x-app.update.prepare (App 2.0 / 3.0 / 4.0).
#
# Engine contract (Axle addendum, 2026-11-15): after Swap, before Start, as a
# one-off, not as root on the host. The Engine uses a generated override that
# sets entrypoint: [command] and an empty command (gap 2 accepted), so argv is
# exactly this script. --no-deps, no ports, no image pull:
#   docker compose run --rm --no-deps --no-TTY --user 0 nextcloud-app
# That override replaces this service's /idea-files-entrypoint.sh, so the image
# entrypoint (and occ upgrade) never runs. --no-deps keeps MariaDB stopped.
# The script sees the swapped compose's volumes and env (./data/nextcloud,
# ./bundled-apps), plus any Engine-injected mounts (unused, harmless).
#
# user: "0" is declared on the step (gaps 10 and 13 accepted) so chown 33 can
# run. The Engine passes it verbatim as run --user and never defaults a step
# to 33. If this ever ran as non-root, chown is skipped and extract still
# works when custom_apps is writable by uid 33. That is not a user-field
# fallback; the field itself is guaranteed.
#
# Resume (gap 6 changed): an interrupted or failed prepare always restores
# the snapshot, and Resume starts the hop again from Swap on the old tree.
# Idempotence is a defensive App rule only (a second run on an already
# staged tree is a no-op once info.xml matches the tarball).
#
# For each bundled tarball: verify sha256 against bundled-apps/SHA256SUMS, then if
# custom_apps/<app> is not already the tarball's version + nextcloud max-version,
# mv the existing folder into a new timestamped subfolder of
# custom_apps/.idea-upgrade-backup/ (never rm -rf, never overwrite a backup) and
# extract the new tree. Fail closed: non-zero exit and a clear ERROR line on any
# mismatch. Target versions are read from each tarball, so the same script
# serves 2.0, 3.0 and 4.0.
#
# Does not invoke occ. Unexpected argv is an error (do not ignore
# apache2-foreground).
#
# Env:
#   IDEA_BUNDLED_APPS          default /idea-bundled-apps
#   IDEA_CUSTOM_APPS           default /var/www/html/custom_apps
#   IDEA_UPGRADE_BACKUP        default $IDEA_CUSTOM_APPS/.idea-upgrade-backup
#   IDEA_UPGRADE_BACKUP_TS     optional fixed stamp (tests; refuse if dest exists)
#   IDEA_WWW_UID / IDEA_WWW_GID  default 33 (www-data); chown only when running as root
set -eu

log() { echo "idea-prep-custom-apps: $*"; }
die() { log "ERROR: $*"; exit 1; }

# Gap 2 accepted: Engine must pass an empty command. Do not ignore leftover argv.
if [ "$#" -ne 0 ]; then
	die "unexpected arguments: $* (Engine must pass an empty command)"
fi

SRC="${IDEA_BUNDLED_APPS:-/idea-bundled-apps}"
DST="${IDEA_CUSTOM_APPS:-/var/www/html/custom_apps}"
BACKUP="${IDEA_UPGRADE_BACKUP:-$DST/.idea-upgrade-backup}"
UID_WWW="${IDEA_WWW_UID:-33}"
GID_WWW="${IDEA_WWW_GID:-$UID_WWW}"

ts() {
	if [ -n "${IDEA_UPGRADE_BACKUP_TS:-}" ]; then
		printf '%s' "$IDEA_UPGRADE_BACKUP_TS"
		return
	fi
	date -u +%Y%m%dT%H%M%S%NZ 2>/dev/null || date -u +%Y%m%dT%H%M%SZ-$$
}

xml_version() { sed -n 's|^[[:space:]]*<version>\([^<]*\)</version>.*|\1|p' "$1" | head -n 1; }

xml_max() { tr '\n' ' ' < "$1" | sed -n 's/.*<nextcloud[^>]*max-version="\([^"]*\)".*/\1/p' | head -n 1; }

already_at_target() {
	app="$1"
	want_info="$2"
	have="$DST/$app/appinfo/info.xml"
	[ -f "$have" ] || return 1
	hv=$(xml_version "$have")
	wv=$(xml_version "$want_info")
	hm=$(xml_max "$have")
	wm=$(xml_max "$want_info")
	[ -n "$hv" ] && [ -n "$wv" ] && [ "$hv" = "$wv" ] && [ -n "$hm" ] && [ -n "$wm" ] && [ "$hm" = "$wm" ]
}

own() {
	if [ "$(id -u)" = 0 ]; then
		chown -R "$UID_WWW:$GID_WWW" "$1" || die "chown $UID_WWW:$GID_WWW failed for $1"
	fi
}

move_aside() {
	src="$1"
	dest="$2"
	if [ -e "$dest" ]; then
		die "refusing to overwrite existing path $dest"
	fi
	mv "$src" "$dest" || die "mv $src -> $dest failed"
}

[ -d "$SRC" ] || die "bundled-apps missing: $SRC"
[ -f "$SRC/SHA256SUMS" ] || die "SHA256SUMS missing in $SRC"

# Every tarball must be listed and match; every SHA256SUMS entry must have a file.
found=0
for tgz in "$SRC"/*.tar.gz; do
	[ -f "$tgz" ] || die "no .tar.gz in $SRC"
	f=$(basename "$tgz")
	want=$(awk -v f="$f" '$2==f {print $1; exit}' "$SRC/SHA256SUMS")
	[ -n "$want" ] || die "$f is not listed in SHA256SUMS"
	case "$want" in
		*[!0-9a-f]*) die "$f SHA256SUMS entry is not lowercase hex: $want" ;;
	esac
	[ ${#want} -eq 64 ] || die "$f SHA256SUMS entry is not 64 hex chars: $want"
	have=$(sha256sum "$tgz" | awk '{print $1}')
	[ "$want" = "$have" ] || die "$f checksum mismatch: expected $want, got $have"
	found=$((found + 1))
done
[ "$found" -gt 0 ] || die "no .tar.gz in $SRC"

while IFS= read -r line || [ -n "$line" ]; do
	[ -n "$line" ] || continue
	name=$(printf '%s\n' "$line" | awk '{print $2}')
	[ -n "$name" ] || die "malformed SHA256SUMS line: $line"
	[ -f "$SRC/$name" ] || die "SHA256SUMS lists $name but the tarball is missing"
done < "$SRC/SHA256SUMS"

mkdir -p "$DST" || die "cannot create $DST"

# Pass 1: plan every app after checksums, and refuse colliding backup dests
# before any mv. Stamp is chosen once per app so preflight and the move agree.
plan="$DST/.idea-prep-plan-$$"
: > "$plan"
cleanup_plan() { rm -f "$plan"; }
# Also drop any leftover info_tmp from a failed plan. plan is a file, not a tree.
trap cleanup_plan EXIT

for tgz in "$SRC"/*.tar.gz; do
	f=$(basename "$tgz")
	case "$f" in
		*-v*.tar.gz) app=${f%%-v*} ;;
		*) die "unexpected tarball name $f (want <app>-v<version>.tar.gz)" ;;
	esac
	[ -n "$app" ] || die "empty app name from $f"

	info_tmp="$DST/.idea-prep-$app-info-$$.xml"
	if ! tar -xOf "$tgz" "$app/appinfo/info.xml" > "$info_tmp"; then
		rm -f "$info_tmp"
		die "cannot read $app/appinfo/info.xml from $f"
	fi
	[ -s "$info_tmp" ] || { rm -f "$info_tmp"; die "$app/appinfo/info.xml from $f is empty"; }
	want_ver=$(xml_version "$info_tmp")
	want_max=$(xml_max "$info_tmp")
	if [ -z "$want_ver" ] || [ -z "$want_max" ]; then
		rm -f "$info_tmp"
		die "$f info.xml is missing <version> or nextcloud max-version"
	fi

	if already_at_target "$app" "$info_tmp"; then
		log "$app already at $want_ver (max-version $want_max) — skip"
		rm -f "$info_tmp"
		# Record a skip so pass 2 can still chown the current tree.
		printf 'SKIP\t%s\n' "$app" >> "$plan"
		continue
	fi

	stamp=$(ts)
	dest=
	if [ -e "$DST/$app" ]; then
		old_info="$DST/$app/appinfo/info.xml"
		if [ -f "$old_info" ]; then
			old_ver=$(xml_version "$old_info")
		else
			old_ver=
		fi
		[ -n "$old_ver" ] || old_ver=unknown
		dest="$BACKUP/${app}-${old_ver}-${stamp}"
		if [ -e "$dest" ]; then
			rm -f "$info_tmp"
			die "refusing to overwrite existing backup $dest"
		fi
	fi
	stage="$DST/.idea-prep-staging-$app-$stamp"
	if [ -e "$stage" ]; then
		rm -f "$info_tmp"
		die "staging dir already exists: $stage"
	fi
	# info_tmp is reread in pass 2 from the tarball; drop the plan-time copy.
	rm -f "$info_tmp"
	# Fields: DO, app, tgz, stamp, dest (empty if no existing app), want_ver, want_max, old_ver
	old_ver_field=
	if [ -n "$dest" ]; then
		# dest is $BACKUP/${app}-${old_ver}-${stamp}; keep the parsed old_ver from above
		old_ver_field=$old_ver
	fi
	printf 'DO\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$app" "$tgz" "$stamp" "$dest" "$want_ver" "$want_max" "$old_ver_field" >> "$plan"
done

# Pass 2: only now move and extract, after every dest has been checked.
while IFS="$(printf '\t')" read -r kind app tgz stamp dest want_ver want_max old_ver; do
	[ -n "$kind" ] || continue
	if [ "$kind" = SKIP ]; then
		own "$DST/$app"
		continue
	fi
	[ "$kind" = DO ] || die "bad plan line: $kind"

	mkdir -p "$BACKUP" || die "cannot create $BACKUP"
	own "$BACKUP"

	if [ -n "$dest" ]; then
		[ -e "$DST/$app" ] || die "$app vanished before backup ($DST/$app)"
		if [ -e "$dest" ]; then
			die "refusing to overwrite existing backup $dest"
		fi
		move_aside "$DST/$app" "$dest"
		log "backed up $app $old_ver to $dest"
	fi

	stage="$DST/.idea-prep-staging-$app-$stamp"
	if [ -e "$stage" ]; then
		die "staging dir already exists: $stage"
	fi
	mkdir -p "$stage" || die "cannot mkdir $stage"
	if ! tar -xzf "$tgz" -C "$stage"; then
		leftover="$BACKUP/${app}-staging-failed-$stamp"
		move_aside "$stage" "$leftover"
		die "extract $(basename "$tgz") failed (staging moved to $leftover)"
	fi
	if [ ! -f "$stage/$app/appinfo/info.xml" ]; then
		leftover="$BACKUP/${app}-staging-badlayout-$stamp"
		move_aside "$stage" "$leftover"
		die "$(basename "$tgz") does not contain $app/appinfo/info.xml (staging moved to $leftover)"
	fi
	got_ver=$(xml_version "$stage/$app/appinfo/info.xml")
	got_max=$(xml_max "$stage/$app/appinfo/info.xml")
	if [ "$got_ver" != "$want_ver" ] || [ "$got_max" != "$want_max" ]; then
		leftover="$BACKUP/${app}-staging-mismatch-$stamp"
		move_aside "$stage" "$leftover"
		die "extracted $app info.xml does not match $(basename "$tgz") (staging moved to $leftover)"
	fi
	[ ! -e "$DST/$app" ] || die "refusing to overwrite $DST/$app"
	mv "$stage/$app" "$DST/$app" || die "mv extracted $app into $DST failed"
	own "$DST/$app"
	if [ -d "$stage" ]; then
		if [ -z "$(ls -A "$stage")" ]; then
			rmdir "$stage" || die "cannot rmdir empty staging $stage"
		else
			leftover="$BACKUP/${app}-staging-leftover-$stamp"
			move_aside "$stage" "$leftover"
			log "moved leftover staging to $leftover"
		fi
	fi
	log "installed $app $want_ver (max-version $want_max) from $(basename "$tgz")"
done < "$plan"

log "done"
exit 0
