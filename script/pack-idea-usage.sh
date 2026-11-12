#!/bin/sh
# Pack idea_usage/ into bundled-apps/idea_usage-v<version>.tar.gz and refresh SHA256SUMS.
# The extract hook requires the tarball to contain idea_usage/appinfo/info.xml.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/idea_usage"
DST="$ROOT/bundled-apps"
ver="$(sed -n 's/.*<version>\([^<]*\)<\/version>.*/\1/p' "$SRC/appinfo/info.xml" | head -n1)"
[ -n "$ver" ] || { echo "pack-idea-usage: no version in info.xml" >&2; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/idea_usage"
# Ship only the app source (no VCS or scratch files).
tar -C "$SRC" -cf - --exclude='.git' --exclude='*.swp' . | tar -C "$tmp/idea_usage" -xf -
tgz="idea_usage-v${ver}.tar.gz"
tar -C "$tmp" -czf "$DST/$tgz" idea_usage
# Rebuild SHA256SUMS for every tarball currently in the folder (stable order).
(
	cd "$DST"
	ls -1 *.tar.gz | sort | while IFS= read -r f; do
		sha256sum "$f"
	done
) > "$DST/SHA256SUMS"
echo "wrote $DST/$tgz"
cat "$DST/SHA256SUMS"
