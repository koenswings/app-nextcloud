#!/bin/bash
# shellcheck disable=SC2034,SC2120,SC2119,SC2013,SC2016,SC1090  # test stand-in, mirrors the stock shape
# tests/fake-mariadb-entrypoint.sh: stand-in for the mariadb image's docker-entrypoint.sh, used by
# tests/db-entrypoint.test.mjs. Same function names, same `for i in {30..0}` wait loop text, same
# sourced/not-sourced switch. No server: the temporary server answers after FAKE_READY_AT probes
# (counted in $FAKE_STATE/probes); the "import" of a *.sql file creates <datadir>/<db>/<table>.frm
# for each CREATE TABLE in it (FAKE_IMPORT=fail makes it fail). Calls are logged to $FAKE_LOG.
set -eo pipefail
shopt -s nullglob

mysql_note() { echo "[Note] [Entrypoint]: $*" >&2; }
mysql_error() { echo "[ERROR] [Entrypoint]: $*" >&2; exit 1; }
flog() { echo "$*" >> "$FAKE_LOG"; }

docker_setup_env() {
	declare -g DATADIR SOCKET DATABASE_ALREADY_EXISTS
	DATADIR="$FAKE_DATADIR/"
	SOCKET="$FAKE_STATE/mysqld.sock"
	DATABASE_ALREADY_EXISTS=
	if [ -d "$DATADIR/mysql" ]; then DATABASE_ALREADY_EXISTS=true; fi
	: "${MARIADB_DATABASE:=${MYSQL_DATABASE:-}}"
}
docker_create_db_directories() { mkdir -p "$DATADIR"; }

fake_probe() {
	local n
	n=$(( $(cat "$FAKE_STATE/probes" 2>/dev/null || echo 0) + 1 ))
	echo "$n" > "$FAKE_STATE/probes"
	if [ "$n" -ge "${FAKE_READY_AT:-1}" ]; then : > "$FAKE_STATE/server-up"; return 0; fi
	return 1
}
docker_temp_server_start() {
	flog "temp-start"
	local i
	for i in {30..0}; do
		if fake_probe; then
			break
		fi
		sleep 0
	done
	if [ "$i" = 0 ]; then
		mysql_error "Unable to start server."
	fi
}
docker_temp_server_stop() { rm -f "$FAKE_STATE/server-up"; flog "temp-stop"; }

docker_process_sql() {
	if [ "$1" = --dont-use-mysql-root-password ]; then shift; fi
	local sql db t
	sql="$(cat)"
	[ -e "$FAKE_STATE/server-up" ] || return 1
	case "$sql" in
	*information_schema.TABLES*)
		db="$(sed -n "s/.*TABLE_SCHEMA='\([^']*\)'.*/\1/p" <<<"$sql")"
		flog "schema-query $db"
		if [ -e "${DATADIR}$db/oc_appconfig.frm" ]; then echo 1; else echo 0; fi ;;
	*)
		flog "import"
		if [ "${FAKE_IMPORT:-}" = fail ]; then return 1; fi
		db="${MYSQL_DATABASE:-nextcloud}"
		mkdir -p "${DATADIR}$db"
		for t in $(grep -o 'CREATE TABLE `[a-z_]*`' <<<"$sql" | sed 's/.*`\(.*\)`/\1/'); do : > "${DATADIR}$db/$t.frm"; done ;;
	esac
}
docker_process_init_files() {
	local f
	for f in "$@"; do
		case "$f" in
		*.sh) . "$f" ;;
		*.sql) docker_process_sql < "$f" ;;
		esac
	done
}
docker_mariadb_init() {
	mkdir -p "$DATADIR/mysql"
	flog "init"
	docker_temp_server_start "$@"
	docker_process_init_files "$FAKE_INITDB"/*
	docker_temp_server_stop
}
_main() {
	if [ "${1:0:1}" = '-' ]; then set -- mariadbd "$@"; fi
	if [ "$1" = mariadbd ] || [ "$1" = mysqld ]; then
		docker_setup_env "$@"
		docker_create_db_directories
		if [ "$(id -u)" = "0" ]; then exec gosu mysql "${BASH_SOURCE[0]}" "$@"; fi
		if [ -z "$DATABASE_ALREADY_EXISTS" ]; then docker_mariadb_init "$@"; fi
	fi
	exec "$@"
}
_is_sourced() {
	[ "${#FUNCNAME[@]}" -ge 2 ] \
		&& [ "${FUNCNAME[0]}" = '_is_sourced' ] \
		&& [ "${FUNCNAME[1]}" = 'source' ]
}
if ! _is_sourced; then
	_main "$@"
fi
