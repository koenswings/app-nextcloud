#!/usr/bin/env bash
# live-container.test.sh — real-container test for the Office URLs and CODE home_mode (idea#212).
# Run ON a claimed pool Pi (needs docker compose and the koenswings/nextcloud* images):
#   test/live-container.test.sh [--keep]
# It copies this checkout to a throwaway dir, starts nextcloud + db + code as its own compose project
# on its own port, and checks, with real occ/coolwsd:
#   A) IDEA_PUBLIC_HOST unset: public_wopi_url, CODE server_name and discovery use the LAN IP; wopi_url
#      is http://code:9980; home_mode is off by default.
#   B) IDEA_PUBLIC_HOST=<test value>: public_wopi_url, server_name and discovery switch, the value is in
#      trusted_domains, wopi_url stays http://code:9980.
# Teardown: compose down for its own project, then the throwaway dir is moved to
# ~/quarantine/ (never deleted; data files are owned by container uids).
# Env: LIVE_IP (LAN IP, default: first eth0/wlan0 IPv4), LIVE_PUBLIC_HOST (default: tailscale0 IPv4),
#      LIVE_PORT (default 18995), LIVE_TIMEOUT (s, default 900). Never prints passwords.
set -uo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEEP=0; [ "${1:-}" = --keep ] && KEEP=1
ip4() { ip -4 -o addr show dev "$1" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1; }
LIP="${LIVE_IP:-$(ip4 eth0)}"; LIP="${LIP:-$(ip4 wlan0)}"
PUB="${LIVE_PUBLIC_HOST:-$(ip4 tailscale0)}"
PORT="${LIVE_PORT:-18995}"; TMO="${LIVE_TIMEOUT:-900}"
[ -n "$LIP" ] && [ -n "$PUB" ] && [ "$LIP" != "$PUB" ] || { echo "need distinct LAN IP and public host (got '$LIP' '$PUB')" >&2; exit 2; }
if ss -ltn | awk '{print $4}' | grep -q ":$PORT\$"; then echo "port $PORT busy" >&2; exit 2; fi
PROJ="an15live$$"; T="$HOME/an15-live-$(date +%Y%m%d%H%M%S)"
mkdir -p "$T" && cp -a "$SRC/." "$T/" && rm -rf "$T/data" "$T/.git" "$T/.env"
cd "$T" || exit 2
pass=0; fail=0
check() { local n="$1"; shift; if "$@"; then echo "PASS $n"; pass=$((pass+1)); else echo "FAIL $n"; fail=$((fail+1)); fi; }
DC() { docker compose -p "$PROJ" --env-file .env "$@"; }
occ() { docker exec -u www-data "${PROJ}-nextcloud-app-1" php occ "$@" 2>/dev/null; }
teardown() {
  DC down --remove-orphans >/dev/null 2>&1
  if [ "$KEEP" = 0 ]; then mkdir -p "$HOME/quarantine"; mv "$T" "$HOME/quarantine/" && echo "quarantined $T -> ~/quarantine/"; fi
}
trap teardown EXIT
mkenv() { # $1 = public host or ""
  { echo "hostname=$(hostname)"; echo "ip=$LIP"; echo "port=$PORT"
    echo "pass=$(head -c 18 /dev/urandom | base64 | tr -dc A-Za-z0-9)"
    echo "IDEA_NC_ADMIN_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -dc A-Za-z0-9)"
    echo "IDEA_NC_SEED_USERS="
    [ -n "$1" ] && echo "IDEA_PUBLIC_HOST=$1"; } > .env; chmod 600 .env
}
wait_office() { # until the office hook finished on this start
  local since="$1" t=0
  while [ $t -lt "$TMO" ]; do
    docker logs --since "$since" "${PROJ}-nextcloud-app-1" 2>&1 | grep -q 'idea-office: done' && return 0
    sleep 10; t=$((t+10))
  done; return 1
}
coolargs() { docker exec "${PROJ}-code-1" sh -c 'cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\0" " " | grep -o "coolwsd [^|]*" | head -1'; }
disco() { local t=0; while [ $t -lt 180 ]; do d="$(curl -fsS "http://$LIP:$PORT/hosting/discovery" 2>/dev/null)" && [ -n "$d" ] && { echo "$d"; return 0; }; sleep 5; t=$((t+5)); done; }

run_phase() { # $1 label, $2 expected browser host, $3 public host env
  local L="$1" H="$2" since; since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkenv "$3"; DC up -d --force-recreate >/dev/null 2>&1 || { echo "FAIL $L: compose up"; fail=$((fail+1)); return; }
  check "$L: office hook done within ${TMO}s" wait_office "$since"
  local pub int td sn args dsc
  pub="$(occ config:app:get richdocuments public_wopi_url)"; int="$(occ config:app:get richdocuments wopi_url)"
  td="$(occ config:system:get trusted_domains)"; sn="$(docker exec "${PROJ}-code-1" printenv server_name)"
  args="$(coolargs)"; dsc="$(disco)"
  echo "  $L public_wopi_url=$pub wopi_url=$int server_name=$sn"
  echo "  $L trusted_domains: $(echo "$td" | tr '\n' ' ')"
  echo "  $L coolwsd home_mode arg: $(grep -o 'home_mode[^ ]*' <<<"$args")"
  echo "  $L discovery urlsrc host: $(grep -o 'urlsrc="http://[^/]*' <<<"$dsc" | sort -u | head -1)"
  check "$L: public_wopi_url = http://$H:$PORT" [ "$pub" = "http://$H:$PORT" ]
  check "$L: wopi_url = http://code:9980" [ "$int" = "http://code:9980" ]
  check "$L: CODE server_name = $H:$PORT" [ "$sn" = "$H:$PORT" ]
  check "$L: discovery urlsrc uses $H:$PORT" grep -q "urlsrc=\"http://$H:$PORT/" <<<"$dsc"
  check "$L: $H in trusted_domains" grep -qx "$H" <<<"$td"
  check "$L: LAN IP $LIP in trusted_domains" grep -qx "$LIP" <<<"$td"
  check "$L: coolwsd runs with home_mode.enable=false" grep -q -- '--o:home_mode.enable=false' <<<"$args"
}
echo "throwaway: $T project: $PROJ port: $PORT lan: $LIP public: $PUB"
run_phase A "$LIP" ""
TDA="$(occ config:system:get trusted_domains)"
check "A: public host $PUB NOT trusted when unset" bash -c '! grep -qx "$1" <<<"$2"' _ "$PUB" "$TDA"
run_phase B "$PUB" "$PUB"
echo "pass=$pass fail=$fail"; [ "$fail" = 0 ]
