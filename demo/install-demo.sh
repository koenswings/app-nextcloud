#!/usr/bin/env bash
# Install (or reuse) the separate IDEA demo Nextcloud instance through the Engine and
# seed it. Callable from an Engine hook (idea#235). Never touches another instance.
#
#   1. find the Engine instance named exactly $NAME (default Nextcloud-Demo) on this Engine;
#      none -> `installApp <APP_ID> <disk> --name <NAME>` (Engine command queue, like the Console)
#   2. verify the target: exactly one instance with that name, compose.yaml x-app.instanceName
#      is exactly NAME, and its app container (<id>-nextcloud-app-1) belongs to compose project <id>
#   3. wait until `occ status` says installed (first start self-installs: admin/admin911!)
#   4. users: run the image's own before-starting/20-idea-accounts.sh hook in that container
#      with IDEA_NC_SEED_USERS = teacher1, teacher2 (teachers), learner1..3 (learners);
#      passwords <name>911!; existing users and passwords are never changed
#   5. files: WebDAV as admin into "IDEA Demo/Worksheets" and "IDEA Demo/Teacher Notes"
#      (a file whose size already matches is skipped), shared read-only with the
#      teachers and learners groups via the OCS share API (once)
# A rerun reuses the instance (no second install) and changes nothing that is already there.
#
# Usage: demo/install-demo.sh --files <dir with Worksheets/ and Teacher Notes/> [--disk <diskId>] [--name NAME]
# Env: ENGINE_DIR (default /home/pi/idea/agents/agent-engine-dev), APP_ID (default nextcloud-latest),
#      DISKS_ROOT (default /disks), DOCKER, CURL, ENGINE_CMD (tests), READY_WAIT (5s steps, default 120)
# Exit codes: 0 ok | 2 usage | 3 Engine unreachable | 11 install failed | 12 ambiguous name
#   | 13 target check failed | 14 not installed/running in time | 15 user seed failed | 16 file seed failed
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="Nextcloud-Demo"; DISK=""; FILES=""
ENGINE_DIR="${ENGINE_DIR:-/home/pi/idea/agents/agent-engine-dev}"
APP_ID="${APP_ID:-nextcloud-latest}"; DISKS_ROOT="${DISKS_ROOT:-/disks}"
DOCKER="${DOCKER:-docker}"; CURL="${CURL:-curl}"
SEED="teacher1:teachers teacher2:teachers learner1:learners learner2:learners learner3:learners"
FOLDERS=("Worksheets" "Teacher Notes")
die() { local c=$1; shift; echo "install-demo: $*" >&2; exit "$c"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2:-}"; shift 2 ;;
    --disk) DISK="${2:-}"; shift 2 ;;
    --files) FILES="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die 2 "unknown argument $1" ;;
  esac
done
[ -n "$FILES" ] && [ -d "$FILES" ] || die 2 "--files <dir> is required"
for f in "${FOLDERS[@]}"; do [ -d "$FILES/$f" ] || die 2 "$FILES/$f missing"; done
[[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die 2 "instance name '$NAME' must be one word (letters, digits, . _ -)"
grep -qi demo <<<"$NAME" || die 2 "instance name '$NAME' must contain 'demo'"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
ecmd() {
  if [ -n "${ENGINE_CMD:-}" ]; then "$ENGINE_CMD" "$@"; return; fi
  [ -d "$WORK/ec" ] || { mkdir -p "$WORK/ec"; cp "$HERE/engine-cmd.mjs" "$WORK/ec/"; ln -s "$ENGINE_DIR/node_modules" "$WORK/ec/node_modules"; }
  (cd "$WORK/ec" && node engine-cmd.mjs "$ENGINE_DIR" "$@")
}
find_named() {
  local js; js=$(ecmd list) || die 3 "Engine not reachable"
  python3 -c 'import json,sys
for i in json.loads(sys.argv[1]):
    if i["name"] == sys.argv[2]:
        print("\t".join(str(i.get(k) or "") for k in ("id","storedOn","device","status","port")))' "$js" "$NAME"
}

M=$(find_named); N=$(printf '%s' "$M" | grep -c . || true)
[ "$N" -le 1 ] || die 12 "REFUSED: $N Engine instances are named '$NAME'; resolve by hand"
if [ "$N" = 0 ]; then
  [ -n "$DISK" ] || die 2 "no instance '$NAME' yet: --disk <diskId> is required to install it"
  echo "Installing a new '$NAME' ($APP_ID) on disk $DISK via the Engine"
  ecmd send "installApp $APP_ID $DISK --name $NAME" || echo "install-demo: installApp reported an error; checking the instance" >&2
  M=$(find_named); N=$(printf '%s' "$M" | grep -c . || true)
  [ "$N" = 1 ] || die 11 "after installApp: $N instances named '$NAME'"
else
  echo "Reusing the existing '$NAME' instance (no new install)"
fi
IFS=$'\t' read -r ID ON DEV ST _ <<<"$M"
[ -z "$DISK" ] || [ "$DISK" = "$ON" ] || die 13 "REFUSED: '$NAME' ($ID) is on disk $ON, not $DISK"
INST="$DISKS_ROOT/$DEV/instances/$ID"
[ -f "$INST/compose.yaml" ] || die 13 "REFUSED: $INST/compose.yaml missing"
XN=$(sed -n 's/^  instanceName:[[:space:]]*//p' "$INST/compose.yaml" | head -1 | tr -d "\"'")
[ "$XN" = "$NAME" ] || die 13 "REFUSED: $INST is instance '$XN', not '$NAME'"
if [ "$ST" != Running ]; then
  echo "'$NAME' is $ST: startInstance via the Engine"
  ecmd send "startInstance $ID $ON" || echo "install-demo: startInstance reported an error; checking the app container" >&2
fi
APP="$ID-nextcloud-app-1"
proj=$($DOCKER inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$APP" 2>/dev/null || true)
[ "$proj" = "$ID" ] || die 13 "REFUSED: container $APP is not part of instance $ID (project '$proj')"
occ() { $DOCKER exec -u www-data "$APP" php occ "$@"; }

for _ in $(seq "${READY_WAIT:-120}"); do occ status 2>/dev/null | grep -q "installed: true" && break; sleep 5; done
occ status 2>/dev/null | grep -q "installed: true" || die 14 "Nextcloud in $APP not installed in time"
PORT=$(sed -n 's/^port=//p' "$INST/.env" | head -1); HOST=$(sed -n 's/^hostname=//p' "$INST/.env" | head -1)
IP=$(sed -n 's/^ip=//p' "$INST/.env" | head -1)
for _ in $(seq "${READY_WAIT:-120}"); do $CURL -sf -o /dev/null "http://127.0.0.1:$PORT/status.php" && break; sleep 5; done

# Users: the app's own accounts hook (policy minLength 9 etc. only where unset).
$DOCKER exec -u www-data -e IDEA_NC_SEED_USERS="$SEED" -e IDEA_OCC_WAIT=60 "$APP" \
  sh /docker-entrypoint-hooks.d/before-starting/20-idea-accounts.sh || die 15 "accounts hook failed"
for pair in $SEED; do occ user:info "${pair%%:*}" >/dev/null || die 15 "user ${pair%%:*} missing after seed"; done

# Files: WebDAV as admin.
A=(-s -u 'admin:admin911!'); DAV="http://127.0.0.1:$PORT/remote.php/dav/files/admin"
enc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$1"; }
mk() { local c; c=$($CURL "${A[@]}" -o /dev/null -w '%{http_code}' -X MKCOL "$DAV/$(enc "$1")") || true
  case "$c" in 201|405) ;; *) die 16 "MKCOL $1 -> $c" ;; esac; }
mk "IDEA Demo"; up=0; skip=0
for f in "${FOLDERS[@]}"; do
  mk "IDEA Demo/$f"
  while IFS= read -r -d '' p; do
    rel="${p#"$FILES/"}"; size=$(stat -c %s "$p")
    have=$($CURL "${A[@]}" -I "$DAV/$(enc "IDEA Demo/$rel")" | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ll]ength: //p' | tail -1)
    if [ "$have" = "$size" ]; then skip=$((skip+1)); continue; fi
    c=$($CURL "${A[@]}" -o /dev/null -w '%{http_code}' -T "$p" "$DAV/$(enc "IDEA Demo/$rel")")
    case "$c" in 201|204) up=$((up+1)) ;; *) die 16 "PUT $rel -> $c" ;; esac
  done < <(find "$FILES/$f" -type f -print0)
done
echo "files: uploaded $up, unchanged $skip"
OCS="http://127.0.0.1:$PORT/ocs/v2.php/apps/files_sharing/api/v1/shares"
shares=$($CURL "${A[@]}" -H 'OCS-APIRequest: true' "$OCS?path=$(enc "/IDEA Demo")&format=json")
for g in teachers learners; do
  if python3 -c 'import json,sys;d=json.loads(sys.argv[1]);sys.exit(0 if any(s.get("share_with")==sys.argv[2] for s in d["ocs"]["data"]) else 1)' "$shares" "$g"; then
    echo "share IDEA Demo -> $g exists"; continue; fi
  c=$($CURL "${A[@]}" -o /dev/null -w '%{http_code}' -H 'OCS-APIRequest: true' -X POST \
      --data-urlencode "path=/IDEA Demo" -d shareType=1 --data-urlencode "shareWith=$g" -d permissions=1 "$OCS")
  [ "$c" = 200 ] || die 16 "share IDEA Demo -> $g: $c"; echo "shared IDEA Demo read-only with $g"
done
echo "DONE: '$NAME' ($ID) http://$HOST:$PORT/ (http://$IP:$PORT/)"
