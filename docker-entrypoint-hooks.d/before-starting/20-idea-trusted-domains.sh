#!/bin/sh
# 20-idea-trusted-domains.sh — keep Nextcloud's trusted_domains in step with the
# Pi the instance runs on (agent-engine-dev#163).
#
# trusted_domains lives in config/config.php on the App Disk, so it travels with
# every copy or move of the instance. On another Pi it still names the old host,
# and Nextcloud answers 400 "Access through untrusted domain". The image's
# NEXTCLOUD_TRUSTED_DOMAINS is applied only at first install, so this hook runs
# from before-starting (every start, as www-data, after install/upgrade).
#
# Env (written into the instance .env by the Engine on every start):
#   IDEA_HOSTNAME   bare hostname of the Pi (e.g. idea03); the hook adds <h>.local
#   IDEA_HOST_IPS   comma-separated IPv4 addresses of the Pi (LAN, Wi-Fi, Tailscale), no ports
#   IDEA_TRUST_LAN_SUBNET  1 (default): also trust a.b.c.* for every private IPv4
#                   (10/8, 172.16/12, 192.168/16); 0: exact addresses only
#   OCC             path to a single occ-compatible binary (tests; default `php occ`)
#
# Rules:
#   - Desired list: localhost, IDEA_HOSTNAME, IDEA_HOSTNAME.local, every IPv4.
#   - The hook remembers what it wrote in the system config key
#     idea_trusted_domains_managed and replaces only those entries. Entries an
#     admin added (or older values it did not write) are kept, after its own.
#   - localhost is always kept.
#   - Idempotent: nothing is written when the config already matches.
#   - Fail open: with both vars empty, or when occ does not answer, the config is
#     left untouched and the hook exits 0 (a hook failure would stop Nextcloud).
#   - Never empties trusted_domains: entries are set by index, then only the
#     stale tail is deleted, highest index first (occ's delete leaves a gap).
#   - The old install-time entry (e.g. idea01:18280, host:port) was not written
#     by this hook, so it stays as a kept entry after the hook's own.
#   - IDEA_HOSTNAME must match ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$, else it
#     is logged and ignored.
set -u
# No pathname expansion: entries such as *.example.com must stay literal in the
# unquoted list loops below.
set -f

log() { echo "idea-trusted-domains: $*"; }

run_occ() {
	if [ -n "${OCC:-}" ]; then
		"$OCC" "$@"
	else
		php occ "$@"
	fi
}

HOST="$(printf '%s' "${IDEA_HOSTNAME:-}" | tr -d '[:space:]')"
HOST="${HOST%.local}"
if [ -n "$HOST" ] && ! printf '%s' "$HOST" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'; then
	log "ignoring IDEA_HOSTNAME '$HOST' (not a valid hostname)"
	HOST=""
fi
IPS_RAW="${IDEA_HOST_IPS:-}"

if [ -z "$HOST" ] && [ -z "$(printf '%s' "$IPS_RAW" | tr -d '[:space:],')" ]; then
	log "IDEA_HOSTNAME and IDEA_HOST_IPS are empty — trusted_domains left unchanged"
	exit 0
fi

# Newline-separated list helpers (values never contain spaces or newlines)
NL='
'
contains() { # $1 = list, $2 = value
	printf '%s\n' "$1" | grep -Fxq -- "$2"
}
append() { # $1 = list, $2 = value → list with value appended once
	if [ -z "$2" ] || contains "$1" "$2"; then printf '%s' "$1"
	elif [ -z "$1" ]; then printf '%s' "$2"
	else printf '%s%s%s' "$1" "$NL" "$2"
	fi
}

desired="localhost"
if [ -n "$HOST" ]; then
	desired="$(append "$desired" "$HOST")"
	desired="$(append "$desired" "$HOST.local")"
fi
OLDIFS="$IFS"; IFS=','
for ip in $IPS_RAW; do
	ip="$(printf '%s' "$ip" | tr -d '[:space:]')"
	[ -z "$ip" ] && continue
	if printf '%s' "$ip" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
		desired="$(append "$desired" "$ip")"
		if [ "${IDEA_TRUST_LAN_SUBNET:-1}" = "1" ] && printf '%s' "$ip" | grep -Eq '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)'; then
			desired="$(append "$desired" "${ip%.*}.*")"
		fi
	else
		log "ignoring '$ip' in IDEA_HOST_IPS (not an IPv4 address)"
	fi
done
IFS="$OLDIFS"

if ! run_occ status >/dev/null 2>&1; then
	log "occ not ready — trusted_domains left unchanged"
	exit 0
fi

# Array values: one per line; a missing key prints nothing
current="$(run_occ config:system:get trusted_domains 2>/dev/null || true)"
managed="$(run_occ config:system:get idea_trusted_domains_managed 2>/dev/null || true)"

final="$desired"
kept=""
for d in $current; do
	if contains "$managed" "$d" || contains "$desired" "$d"; then continue; fi
	final="$(append "$final" "$d")"
	kept="$(append "$kept" "$d")"
done

# What this hook owns from now on: the desired list minus localhost (always kept anyway)
own="$(printf '%s\n' "$desired" | grep -Fxv localhost || true)"

if [ "$final" = "$current" ] && [ "$own" = "$managed" ]; then
	log "trusted_domains already up to date ($(printf '%s' "$final" | tr '\n' ' '))"
	exit 0
fi

fail() { log "WARNING: $* — Nextcloud keeps its previous trusted_domains"; exit 0; }

i=0
for d in $final; do
	run_occ config:system:set trusted_domains "$i" --value="$d" >/dev/null 2>&1 || fail "could not set trusted_domains $i"
	i=$((i + 1))
done
n_cur="$(printf '%s\n' "$current" | grep -c . || true)"
k=$((n_cur - 1))
while [ "$k" -ge "$i" ]; do
	run_occ config:system:delete trusted_domains "$k" >/dev/null 2>&1 || log "WARNING: could not delete stale trusted_domains $k"
	k=$((k - 1))
done

j=0
for d in $own; do
	run_occ config:system:set idea_trusted_domains_managed "$j" --value="$d" >/dev/null 2>&1 || fail "could not record idea_trusted_domains_managed"
	j=$((j + 1))
done
n_man="$(printf '%s\n' "$managed" | grep -c . || true)"
k=$((n_man - 1))
while [ "$k" -ge "$j" ]; do
	run_occ config:system:delete idea_trusted_domains_managed "$k" >/dev/null 2>&1 || true
	k=$((k - 1))
done

log "trusted_domains = $(printf '%s' "$final" | tr '\n' ' ')${kept:+(kept: $(printf '%s' "$kept" | tr '\n' ' '))}"
exit 0
