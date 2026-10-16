#!/usr/bin/env bash
# Read-only fingerprint of Nextcloud instance folders (the containers keep running):
# sha256 of compose.yaml, .env and config/config.php; occ user:list and
# files_external:list (read-only occ, as www-data); file list with sizes of the data dir.
# Usage: sudo tests/fingerprint-nextcloud.sh INSTANCE_DIR...
set -uo pipefail
h() { sha256sum | cut -c1-16; }
for d in "$@"; do
  id=$(basename "$d"); app="$id-nextcloud-app-1"
  sh_() { [ -f "$1" ] && sha256sum "$1" | cut -c1-16 || echo none; }
  ul=$(docker exec -u www-data "$app" php occ user:list --output=json 2>/dev/null)
  sl=$(docker exec -u www-data "$app" php occ files_external:list --output=json 2>/dev/null)
  fl=$(cd "$d/data/nextcloud/data" 2>/dev/null && find . -type f -printf '%P %s\n' | sort)
  printf '%s compose=%s env=%s config.php=%s users=%s(%s) storages=%s files=%s(%s)\n' "$id" \
    "$(sh_ "$d/compose.yaml")" "$(sh_ "$d/.env")" "$(sh_ "$d/data/nextcloud/config/config.php")" \
    "$(printf '%s' "$ul" | h)" "$(printf '%s' "$ul" | python3 -c 'import json,sys;print(",".join(sorted(json.load(sys.stdin))))' 2>/dev/null)" \
    "$(printf '%s' "$sl" | h)" "$(printf '%s' "$fl" | h)" "$(printf '%s' "$fl" | grep -c .)"
done
