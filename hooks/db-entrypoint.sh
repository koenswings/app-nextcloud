#!/bin/bash
# hooks/db-entrypoint.sh: nextcloud-db entrypoint wrapper (agent-engine-dev#468, app-nextcloud#42).
#
# compose: entrypoint: ["bash", "/idea/db/entrypoint.sh"], command unchanged. It sources the
# image's own /usr/local/bin/docker-entrypoint.sh (which does nothing when sourced), changes two
# things, then runs the stock _main:
#
# 1. Longer temporary-server wait. The stock docker_temp_server_start polls `SELECT 1` 31 times
#    with sleep 1 ({30..0}); there is no env to change that. MariaDB 11.8.9 on a Pi took longer
#    than that on a restore (fresh init + CODE starting), so the dump was never imported and the
#    entrypoint exited 1 (#468). The loop is rewritten to IDEA_DB_START_WAIT tries (default 300)
#    from the stock function text; if the text no longer has {30..0} the stock loop is kept and
#    the retry below still covers it.
# 2. Retry-safe restore import. A hook archive has no data/db, so a restore starts with an empty
#    datadir and data/backup/db/nextcloud.sql (the initdb folder). Before init this writes
#    $DATADIR/.idea-restore-pending. The marker is removed only after the import, when
#    nextcloud.oc_appconfig exists (checked with SQL on the temporary server, before it stops)
#    and the temporary server stopped cleanly; then .idea-schema-expected is written.
#    If a start finds the marker (or the dump's own .idea-import-pending) next to an initialised
#    datadir (mysql/), the import never completed: a plain restart would skip initdb (datadir not
#    empty) and could turn healthy with no Nextcloud data. So the datadir contents are moved (mv,
#    never deleted) into a NEW folder /idea/db-quarantine/db-<UTC stamp>-<pid>
#    (host: data/db-quarantine/) and the stock entrypoint re-initialises and imports again.
#    restart: on-failure:3 on nextcloud-db gives up to 3 such retries.
#    With a marker but no dump nothing is moved (nothing to import): the db stays unhealthy.
#
# Fresh install (no dump) and a normal start (datadir initialised, no marker) take the stock path
# unchanged apart from the longer wait. Runs as root first (move + marker, as the stock root
# phase), then re-execs itself as mysql via gosu like the stock entrypoint does.
# Never prints a password. No rm -rf: only the one marker file is removed.
set -eo pipefail

STOCK="${IDEA_DB_STOCK_ENTRYPOINT:-/usr/local/bin/docker-entrypoint.sh}"
QDIR="${IDEA_DB_QUARANTINE_DIR:-/idea/db-quarantine}"
INITDB="${IDEA_DB_INITDB_DIR:-/docker-entrypoint-initdb.d}"
WAIT="${IDEA_DB_START_WAIT:-300}"
MARK=.idea-restore-pending
OLD_MARK=.idea-import-pending       # written by the dump's 00-idea-import-begin.sh (backup-db-dump.sh)
EXPECT=.idea-schema-expected        # db-healthcheck.sh then requires the Nextcloud schema

idea_log() { printf '%s [Note] [IDEA db]: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

# shellcheck source=/dev/null
. "$STOCK"

for f in _main docker_setup_env docker_create_db_directories docker_temp_server_start \
	docker_temp_server_stop docker_process_sql mysql_error; do
	if ! declare -F "$f" >/dev/null; then
		idea_log "stock entrypoint has no $f(); running it unchanged (no longer wait, no restore retry)"
		exec "$STOCK" "$@"
	fi
done

# Same normalisation as the stock _main: an option first means mariadbd.
if [ "${1:0:1}" = '-' ]; then
	set -- mariadbd "$@"
fi
if [ "$1" != mariadbd ] && [ "$1" != mysqld ]; then
	exec "$STOCK" "$@"
fi

idea_db_name() { printf '%s' "${MARIADB_DATABASE:-${MYSQL_DATABASE:-nextcloud}}"; }

idea_quarantine_datadir() {
	local dest e
	dest="$QDIR/db-$(date -u +%Y%m%dT%H%M%SZ)-$$"
	mkdir -p "$QDIR"
	mkdir "$dest"   # fails if it exists: always a new folder
	shopt -s dotglob nullglob
	for e in "${DATADIR%/}"/*; do
		mv -- "$e" "$dest/"
	done
	shopt -u dotglob
	idea_log "restore: the last import never completed; moved the half-initialised data dir into $dest (kept, not deleted); re-initialising"
}

# Root phase (or the only phase when started as non-root): decide before init.
idea_restore_prepare() {
	local dump="$INITDB/nextcloud.sql" d="${DATADIR%/}"
	if { [ -e "$d/$MARK" ] || [ -e "$d/$OLD_MARK" ]; } && [ -d "$d/mysql" ]; then
		if [ -s "$dump" ]; then
			idea_quarantine_datadir
		else
			idea_log "restore: import marker present but no dump at $dump; data dir left as is (stays unhealthy)"
			return 0
		fi
	fi
	if [ ! -d "$d/mysql" ] && [ -s "$dump" ]; then
		: > "$d/$MARK"
		sync "$d/$MARK" 2>/dev/null || sync
		idea_log "restore: empty data dir and $dump present: import pending ($MARK)"
	fi
}

# Called (via the docker_temp_server_stop override) while the temporary server still runs.
idea_restore_verify() {
	IDEA_RESTORE_STATE=
	[ -e "${DATADIR%/}/$MARK" ] || return 0
	local db n
	db="$(idea_db_name)"
	n="$(docker_process_sql --database=mysql --skip-column-names --batch \
		<<<"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${db}' AND TABLE_NAME='oc_appconfig'" 2>/dev/null || true)"
	if [ "$n" = 1 ]; then
		IDEA_RESTORE_STATE=ok
	else
		IDEA_RESTORE_STATE=missing
	fi
}

idea_restore_finish() {
	local d="${DATADIR%/}"
	case "${IDEA_RESTORE_STATE:-}" in
	ok)
		: > "$d/$EXPECT"
		rm -f "$d/$MARK"
		sync
		idea_log "restore: import done, $(idea_db_name).oc_appconfig present; $MARK cleared"
		;;
	missing)
		mysql_error "restore: $(idea_db_name).oc_appconfig missing after the import; $MARK kept so the next start retries"
		;;
	esac
}

idea_install_overrides() {
	local f rep
	f="$(declare -f docker_temp_server_start)"
	if [[ "$WAIT" =~ ^[0-9]+$ ]] && [ "$WAIT" -ge 1 ] && [[ "$f" == *'{30..0}'* ]]; then
		rep="\$(seq $WAIT -1 0)"
		eval "${f/'{30..0}'/$rep}"
		idea_log "temporary server start wait: $WAIT tries (stock 30)"
	else
		idea_log "temporary server start wait: stock loop kept"
	fi
	eval "idea_stock_$(declare -f docker_temp_server_stop)"
	docker_temp_server_stop() {
		idea_restore_verify
		idea_stock_docker_temp_server_stop
		idea_restore_finish
	}
}

if [ -z "${IDEA_DB_PREPARED:-}" ]; then
	docker_setup_env "$@"
	idea_restore_prepare
	if [ "$(id -u)" = 0 ]; then
		docker_create_db_directories
		export IDEA_DB_PREPARED=1
		exec gosu mysql bash "${BASH_SOURCE[0]}" "$@"
	fi
fi
unset IDEA_DB_PREPARED
idea_install_overrides
_main "$@"
