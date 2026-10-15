#!/bin/sh
# 20-idea-accounts.sh — IDEA default accounts and password policy (idea: 911! scheme).
#
# IDEA default password for every app account is <account name>911!
# (admin911!, teacher1911!, learner1911!). Easy to type on purpose; teachers
# change them before real use. The admin itself is created by the image's
# auto-install from NEXTCLOUD_ADMIN_USER / NEXTCLOUD_ADMIN_PASSWORD (compose).
#
# NC 31 password_policy defaults reject these values: minLength 10 ('admin911!'
# is 9 chars) and the HaveIBeenPwned check. This hook sets, ONLY when the admin
# has never set them: minLength=9 and enforceHaveIBeenPwned=false. Anything an
# admin configured is left alone. Other rules (common-password list, etc.) stay.
#
# Then it creates the seed users that are missing, password <user>911!, and adds
# them to their group (created if missing). Existing users are never changed and
# passwords are never reset, so a changed password survives restarts.
#
# Env:
#   IDEA_NC_SEED_USERS  space-separated user:group list
#                       (default "teacher1:teachers learner1:learners"; "" = none)
#   IDEA_NC_PASSWORD_SUFFIX  default 911!
#   OCC, IDEA_OCC_WAIT, IDEA_OCC_INTERVAL  as in 10-idea-files.sh
# Fail open: always exits 0.
set -u
run_occ() { if [ -n "${OCC:-}" ]; then "$OCC" "$@"; else php /var/www/html/occ "$@"; fi; }
log() { echo "idea-accounts: $*"; }
SEED="${IDEA_NC_SEED_USERS-teacher1:teachers learner1:learners}"
SUFFIX="${IDEA_NC_PASSWORD_SUFFIX:-911!}"
W="${IDEA_OCC_WAIT:-120}"; I="${IDEA_OCC_INTERVAL:-3}"
case "$W" in ''|*[!0-9]*) W=120 ;; esac; case "$I" in ''|*[!0-9]*|0) I=3 ;; esac
t=0
while :; do
	if st="$(run_occ status 2>/dev/null)"; then
		case "$st" in *"installed: true"*) break ;; *) log "not installed — skip"; exit 0 ;; esac
	fi
	[ "$t" -ge "$W" ] && { log "occ not ready after ${W}s — skip"; exit 0; }
	sleep "$I"; t=$((t + I))
done

# Policy defaults, only where unset (admin choices win).
setdef() { run_occ config:app:get password_policy "$1" >/dev/null 2>&1 && return 0
	run_occ config:app:set password_policy "$1" --value="$2" --type="$3" >/dev/null 2>&1 \
		&& log "password_policy $1=$2" || log "WARNING could not set password_policy $1"; }
setdef minLength 9 integer
setdef enforceHaveIBeenPwned false boolean

set -f
for pair in $SEED; do
	u="${pair%%:*}"; g="${pair#*:}"; [ "$g" = "$pair" ] && g=""
	case "$u" in ''|*[!A-Za-z0-9._-]*) log "WARNING bad user '$u' — skip"; continue ;; esac
	if run_occ user:info "$u" >/dev/null 2>&1; then log "$u exists — unchanged"; else
		if OC_PASS="$u$SUFFIX" run_occ user:add --password-from-env --display-name="$u" "$u" >/dev/null 2>&1; then
			log "created $u"; else log "WARNING could not create $u"; continue; fi
	fi
	[ -n "$g" ] || continue
	run_occ group:add "$g" >/dev/null 2>&1 || true
	run_occ group:adduser "$g" "$u" >/dev/null 2>&1 || true
done
exit 0
