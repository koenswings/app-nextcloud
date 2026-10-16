#!/usr/bin/env bash
# Install (or re-seed) the separate "Nextcloud Demo" instance through the IDEA Engine.
#
# Koen, 2026-10-16: the demo is always its OWN Nextcloud instance named "Nextcloud Demo",
# installed alongside any real Nextcloud. It never seeds into an existing Nextcloud.
#
# The Engine is driven ONLY through its store command queue, exactly like the Console
# (push onto engineDB[<engine>].commands, follow the command-log trace to ok/error).
# Helper: demo/engine-cmd.mjs (list | disks | send "<cmd>").
#
# Flow:
#   1. pick the instance whose display name is exactly "Nextcloud Demo" (more than one: exit 10)
#   2. none -> installApp <app> <disk> --source <disk> --name "Nextcloud Demo" --fresh
#      (--fresh: the app bundle, never a copy of a school's data; without the bundle on
#      <source> the Engine falls back to its clean GitHub build). Refused unless the new
#      folder's compose x-app.instanceName is exactly "Nextcloud Demo".
#   3. startInstance if it is not Running (Nextcloud seeds through occ/WebDAV on a running server)
#   4. guard: occ user:list may only hold the demo accounts (else exit 6, nothing changed)
#   5. groups teachers/learners; users admin, teacher1, teacher2, learner1..3 with password
#      <name>911! (existing users keep their password unless --force-passwords)
#   6. WebDAV upload of Worksheets/ and Teacher Notes/ from the IDEA-DEMO folder into
#      teacher1 and teacher2 (rerun overwrites the same paths: no duplicates)
#
# Usage: demo/install-demo.sh [--engine-dir DIR] [--disk ID] [--instance ID] [--content DIR]
#                             [--source ID] [--app ID] [--force-passwords] [--dry-run]
#   --source ID    disk holding apps/<app> (default: the target disk)  [$DEMO_SOURCE]
#   --content DIR  folder holding "Worksheets" and "Teacher Notes"  [$DEMO_CONTENT]
# Env for hooks/tests: ENGINE_CMD, OCC (command prefix replacing "docker exec -u 33 <c> php occ"),
#   NC_CONTAINER, CURL (default curl), NC_URL (default http://127.0.0.1:<port>), DOCKER.
# Last stdout line is JSON: {"result":"installed|reseeded","id":..,"name":..,"disk":..,"port":..}
#
# Exit codes: 0 ok | 2 usage | 3 Engine/store unreachable | 6 instance holds non-demo users |
#   10 more than one demo instance | 11 target refused | 12 installApp Failed |
#   13 no instance with the demo name after install | 14 not ready in time | 15 occ seeding failed |
#   16 WebDAV upload failed | 17 startInstance Failed | 18 no/ambiguous target disk
set -uo pipefail

DEMO_NAME="Nextcloud Demo"
DEMO_USERS="admin teacher1 teacher2 learner1 learner2 learner3"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { local c=$1; shift; echo "ERROR: $*" >&2; exit "$c"; }
engine() {
  if [ -n "${ENGINE_CMD:-}" ]; then $ENGINE_CMD "$@"; return; fi
  # engine-cmd.mjs needs the Engine's node_modules: run it from a temp dir that links them.
  if [ -z "${EC_DIR:-}" ]; then
    EC_DIR="$(mktemp -d)"; trap 'rm -rf "$EC_DIR"' EXIT
    cp "$HERE/engine-cmd.mjs" "$EC_DIR/"; ln -s "$ENGINE_DIR/node_modules" "$EC_DIR/node_modules"
  fi
  (cd "$EC_DIR" && node engine-cmd.mjs "$ENGINE_DIR" "$@")
}
# x-app.instanceName of an instance folder (quotes stripped)
compose_name() { sed -n 's/^  instanceName:[[:space:]]*//p' "$1/compose.yaml" 2>/dev/null | head -1 | sed -e "s/^[\"']//" -e "s/[\"']\$//"; }
wait_ready() {  # first start self-installs (minutes on a Pi): occ status installed + status.php
  [ "$DRY" = 1 ] && return 0
  local n="${READY_WAIT:-120}"
  for _ in $(seq "$n"); do occ status 2>/dev/null | grep -q "installed: true" && break; sleep "${READY_STEP:-5}"; done
  occ status 2>/dev/null | grep -q "installed: true" || return 1
  for _ in $(seq "$n"); do ${CURL:-curl} -sf -o /dev/null "$NC_URL/status.php" && return 0; sleep "${READY_STEP:-5}"; done
  return 1
}
pick() {  # $1 JSON, $2 field, $3 value: "id<TAB>name<TAB>storedOn<TAB>status<TAB>port" per match
  printf '%s' "$1" | node -e '
    const [f, v] = process.argv.slice(1); let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      for (const i of JSON.parse(s || "[]")) if (i && i[f] === v)
        console.log([i.id, i.name, i.storedOn, i.status ?? "", i.port ?? ""].join("\t")) })' "$2" "$3"
}
send() {
  echo "engine: $1" >&2
  [ "$DRY" = 1 ] && return 0
  local out rc; out="$(engine send "$1")"; rc=$?; [ -n "$out" ] && echo "$out" >&2; return $rc
}
occ() {
  echo "+ occ $*" >&2
  [ "$DRY" = 1 ] && return 0
  if [ -n "${OCC:-}" ]; then $OCC "$@"; else ${DOCKER:-docker} exec -u 33 "${OCC_ENV[@]}" "$CONTAINER" php occ "$@"; fi
}
container_for() {
  ${DOCKER:-docker} ps -q --filter "label=com.docker.compose.project=$1" --filter "label=com.docker.compose.service=nextcloud-app" | head -1
}

seed_users() {
  local users; users="$(occ user:list --output=json)" || return 15
  if [ "$DRY" != 1 ]; then
    local foreign; foreign="$(printf '%s' "$users" | node -e '
      const ok = new Set(process.argv[1].split(" ")); let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
        console.log(Object.keys(JSON.parse(s || "{}")).filter(u => !ok.has(u)).join(" ")) })' "$DEMO_USERS")"
    [ -z "$foreign" ] || { echo "ERROR: refusing: this Nextcloud has non-demo users ($foreign)" >&2; return 6; }
  fi
  occ group:add teachers >/dev/null 2>&1; occ group:add learners >/dev/null 2>&1
  local u grp
  for u in $DEMO_USERS; do
    case "$u" in admin) grp=admin ;; teacher*) grp=teachers ;; *) grp=learners ;; esac
    if [ "$DRY" != 1 ] && printf '%s' "$users" | grep -q "\"$u\""; then
      if [ "$FORCE" = 1 ]; then OCC_ENV=(-e "OC_PASS=${u}911!"); OC_PASS="${u}911!" occ user:resetpassword --password-from-env "$u" || return 15; fi
    else
      OCC_ENV=(-e "OC_PASS=${u}911!"); OC_PASS="${u}911!" occ user:add --password-from-env --group "$grp" "$u" || return 15
    fi
    OCC_ENV=(); occ group:adduser "$grp" "$u" >/dev/null 2>&1
  done
  return 0
}

upload() {  # WebDAV into teacher1/teacher2
  local u f rel
  for u in teacher1 teacher2; do
    for top in "Worksheets" "Teacher Notes"; do
      [ -d "$CONTENT/$top" ] || { echo "ERROR: missing $CONTENT/$top" >&2; return 16; }
      while IFS= read -r -d '' f; do
        rel="${f#"$CONTENT"/}"
        echo "+ PUT $u:/$rel" >&2; [ "$DRY" = 1 ] && continue
        ${CURL:-curl} -fsS -u "$u:${u}911!" -X MKCOL "$NC_URL/remote.php/dav/files/$u/$(enc "$top")" >/dev/null 2>&1
        ${CURL:-curl} -fsS -u "$u:${u}911!" -T "$f" "$NC_URL/remote.php/dav/files/$u/$(enc "$rel")" >/dev/null || return 16
      done < <(find "$CONTENT/$top" -maxdepth 1 -type f -print0)
    done
  done
}
enc() { node -e 'console.log(process.argv[1].split("/").map(encodeURIComponent).join("/"))' "$1"; }

main() {
  ENGINE_DIR="${ENGINE_DIR:-}"; DISK="${DEMO_DISK:-}"; TARGET=""; CONTENT="${DEMO_CONTENT:-}"
  SRC="${DEMO_SOURCE:-}"; APP="${DEMO_APP:-nextcloud-1.0}"; DRY=0; FORCE=0; OCC_ENV=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --engine-dir) ENGINE_DIR="${2:?}"; shift 2 ;;
      --disk) DISK="${2:?}"; shift 2 ;;
      --source) SRC="${2:?}"; shift 2 ;;
      --instance) TARGET="${2:?}"; shift 2 ;;
      --content) CONTENT="${2:?}"; shift 2 ;;
      --app) APP="${2:?}"; shift 2 ;;
      --force-passwords) FORCE=1; shift ;;
      --dry-run) DRY=1; shift ;;
      -h|--help) sed -n '2,37p' "$0"; exit 0 ;;
      *) die 2 "unknown argument $1" ;;
    esac
  done
  [ -n "${ENGINE_CMD:-}" ] || [ -n "$ENGINE_DIR" ] || die 2 "--engine-dir (or ENGINE_DIR) is required"
  [ -n "$CONTENT" ] || die 2 "--content <IDEA-DEMO folder> is required"

  local list rows id name disk status port result
  list="$(engine list)" || die 3 "Engine store not reachable"
  if [ -n "$TARGET" ]; then
    rows="$(pick "$list" id "$TARGET")"; [ -n "$rows" ] || die 11 "instance $TARGET is not on a disk docked here"
    [ "$(cut -f2 <<<"$rows")" = "$DEMO_NAME" ] || die 11 "refusing $TARGET: its name is '$(cut -f2 <<<"$rows")', not '$DEMO_NAME'"
  else
    rows="$(pick "$list" name "$DEMO_NAME")"
    [ "$(grep -c . <<<"$rows")" -gt 1 ] && die 10 "more than one instance is named '$DEMO_NAME'; pass --instance <id>"
  fi
  result=reseeded
  if [ -z "$rows" ]; then
    if [ -z "$DISK" ]; then
      DISK="$(engine disks | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s||"[]");if(d.length===1)console.log(d[0].id)})')"
      [ -n "$DISK" ] || die 18 "pass --disk <id>: not exactly one disk is docked"
    fi
    send "installApp $APP $DISK --source ${SRC:-$DISK} --name \"$DEMO_NAME\" --fresh" || die 12 "installApp Failed (see the Engine command log)"
    [ "$DRY" = 1 ] && { echo '{"result":"dry-run"}'; return 0; }
    list="$(engine list)" || die 3 "Engine store not reachable"
    rows="$(pick "$list" name "$DEMO_NAME")"
    [ "$(grep -c . <<<"$rows")" = 1 ] || die 13 "installApp reported Done but no single instance is named '$DEMO_NAME'"
    result=installed
  fi
  IFS=$'\t' read -r id name disk status port <<<"$rows"
  if [ "$DRY" != 1 ]; then
    local dev; dev="$(engine list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s||"[]").find(i=>i&&i.id===process.argv[1]);if(i)console.log(i.device??"")})' "$id")"
    local inst="${DISKS_ROOT:-/disks}/$dev/instances/$id"
    [ "$(compose_name "$inst")" = "$DEMO_NAME" ] || die 11 "refusing $id: compose x-app.instanceName is '$(compose_name "$inst")', not '$DEMO_NAME'"
  fi
  if [ "$status" != "Running" ]; then send "startInstance $id $disk" || die 17 "startInstance Failed"; fi

  NC_URL="${NC_URL:-http://127.0.0.1:$port}"
  if [ -z "${OCC:-}" ] && [ "$DRY" != 1 ]; then
    CONTAINER="${NC_CONTAINER:-$(container_for "$id")}"; [ -n "$CONTAINER" ] || die 15 "no running nextcloud-app container for $id"
  fi
  wait_ready || die 14 "Nextcloud $id not installed/answering in time"
  local rc=0; seed_users || rc=$?
  [ $rc = 0 ] || die $rc "user seeding stopped (exit $rc)"
  upload || die 16 "WebDAV upload failed"
  # Office: (re)fetch the CODE discovery so documents open right away (fail open).
  occ richdocuments:activate-config >/dev/null 2>&1 || echo "WARNING: richdocuments:activate-config failed; Office may need a restart" >&2
  printf '{"result":"%s","id":"%s","name":"%s","disk":"%s","port":"%s"}\n' "$result" "$id" "$DEMO_NAME" "$disk" "$port"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
