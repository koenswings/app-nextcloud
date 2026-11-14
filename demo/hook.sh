#!/usr/bin/env bash
# Engine demo seed hook for Nextcloud (agent-engine-dev#369).
#
# The Engine runs this as:  <apps>/<appId>/demo/hook.sh seed
# with cwd = the instance folder and:
#   IDEA_DEMO=1, IDEA_DEMO_INSTANCE_ID, IDEA_DEMO_INSTANCE_DIR, IDEA_DEMO_DATA_DIR
#   (<instance>/data for Nextcloud), IDEA_DEMO_PACK_DIR (<instance>/demo-pack/x),
#   IDEA_DEMO_PORT, IDEA_DEMO_COMPOSE_PROJECT
#
# The Engine owns install, stop and start. This hook only seeds. It never calls
# engine-cmd, the command queue, installApp, startInstance, stopInstance or
# docker compose, and it never writes under /tmp or mktemp. A pack tar is unpacked
# only under ${IDEA_DEMO_PACK_DIR} (normally the Engine has already done that).
#
# Steps (Nextcloud):
#   seed (needs: running) — seed_nextcloud.py: groups and demo accounts through
#        `docker exec ... php occ` in this instance's own nextcloud-app container,
#        then folders, files and group shares through WebDAV / OCS on
#        127.0.0.1:${IDEA_DEMO_PORT}. Idempotent: a re-press adds only what is
#        missing and gives no duplicates.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { local c=$1; shift; echo "ERROR: $*" >&2; exit "$c"; }

# Refuse a pack dir on /tmp (the contract is instance/demo-pack/x/).
assert_pack_dir() {
  local d="${IDEA_DEMO_PACK_DIR:-}"
  [ -n "$d" ] || die 2 "IDEA_DEMO_PACK_DIR is required"
  local resolved parent
  if [ -d "$d" ]; then
    resolved="$(cd "$d" && pwd -P)"
  else
    parent="$(cd "$(dirname "$d")" 2>/dev/null && pwd -P)" || die 2 "IDEA_DEMO_PACK_DIR parent does not exist: $d"
    resolved="$parent/$(basename "$d")"
  fi
  case "$resolved" in
    /tmp|/tmp/*) die 2 "IDEA_DEMO_PACK_DIR must not be under /tmp: $resolved" ;;
  esac
  IDEA_DEMO_PACK_DIR="$resolved"
  export IDEA_DEMO_PACK_DIR
}

# If the Engine left the verified tar beside x/ and x/ is not yet extracted, unpack it here.
extract_pack_if_needed() {
  [ -f "$IDEA_DEMO_PACK_DIR/pack.json" ] && return 0
  local inst="${IDEA_DEMO_INSTANCE_DIR:-}" tar="" cand m
  if [ -n "${IDEA_DEMO_PACK_TAR:-}" ] && [ -f "$IDEA_DEMO_PACK_TAR" ]; then
    tar="$IDEA_DEMO_PACK_TAR"
  elif [ -n "$inst" ]; then
    for cand in "$inst"/demo-pack/idea-demo-nextcloud-v*.tar; do
      [ -f "$cand" ] && tar="$cand" && break
    done
  fi
  [ -n "$tar" ] || die 2 "no pack.json in $IDEA_DEMO_PACK_DIR and no pack tar to extract"
  while IFS= read -r m; do
    m="${m%/}"
    case "$m" in
      /*|..|../*|*/..|*/../*) die 2 "refusing unsafe tar member: $m" ;;
    esac
  done < <(tar -tf "$tar")
  mkdir -p "$IDEA_DEMO_PACK_DIR"
  echo "+ tar -xf $tar -C $IDEA_DEMO_PACK_DIR" >&2
  tar -xf "$tar" -C "$IDEA_DEMO_PACK_DIR"
  [ -f "$IDEA_DEMO_PACK_DIR/pack.json" ] || die 2 "pack tar $tar has no pack.json at its root"
}

step_seed() {
  assert_pack_dir
  extract_pack_if_needed
  [ -n "${IDEA_DEMO_PORT:-}${NC_URL:-}" ] || die 2 "IDEA_DEMO_PORT is required for seed"
  echo "+ seed_nextcloud.py (pack $IDEA_DEMO_PACK_DIR, port ${IDEA_DEMO_PORT:-}, project ${IDEA_DEMO_COMPOSE_PROJECT:-})" >&2
  [ "${DRY:-0}" = 1 ] && return 0
  export PYTHONDONTWRITEBYTECODE=1
  if [ -n "${SEED:-}" ]; then $SEED; else python3 "$HERE/seed_nextcloud.py"; fi
}

usage() {
  sed -n '2,21p' "$0"
  exit 2
}

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0 2>/dev/null || true
fi

case "${1:-}" in
  seed) step_seed ;;
  -h|--help|"") usage ;;
  *) die 2 "unknown step '${1:-}': use seed" ;;
esac
