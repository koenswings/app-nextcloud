#!/bin/bash
# hooks/db-healthcheck.sh: nextcloud-db Docker healthcheck (agent-engine-dev#468, app-nextcloud#42).
#
# Healthy only when all of these hold:
#  - no .idea-restore-pending (db-entrypoint.sh: a restore import is running or never completed)
#    and no .idea-import-pending (the dump's own begin/end markers: an import broke half-way);
#  - the image's healthcheck.sh --connect --innodb_initialized (as before: the healthcheck user
#    from .my-healthcheck.cnf; --connect is false on the skip-networking temporary server);
#  - the Nextcloud schema (nextcloud/oc_appconfig.frm) is there, BUT only once it is expected.
#
# Why "once expected": nextcloud-app depends_on nextcloud-db service_healthy, and on a fresh install
# Nextcloud creates its tables only after it starts. Requiring the schema always would deadlock every
# fresh install. It is expected when data/db/.idea-schema-expected exists: written by
# db-entrypoint.sh after a verified restore import, and by this script the first time it sees the
# schema (after the first install, or on an instance from before this check). From then on a
# datadir without the schema never turns healthy again, so Nextcloud never starts on an empty db.
# The schema test is a file test (MariaDB keeps a .frm per table) so the healthcheck user needs no
# grant on the nextcloud database. No password is used or printed.
D="${IDEA_DB_DATADIR:-/var/lib/mysql}"
DB="${MARIADB_DATABASE:-${MYSQL_DATABASE:-nextcloud}}"
HC="${IDEA_DB_IMAGE_HEALTHCHECK:-healthcheck.sh}"

if [ -e "$D/.idea-restore-pending" ]; then echo "restore import pending or never completed"; exit 1; fi
if [ -e "$D/.idea-import-pending" ]; then echo "dump import broke half-way"; exit 1; fi
"$HC" --connect --innodb_initialized || exit 1
if [ -e "$D/$DB/oc_appconfig.frm" ]; then
	[ -e "$D/.idea-schema-expected" ] || : > "$D/.idea-schema-expected" 2>/dev/null || true
	exit 0
fi
if [ -e "$D/.idea-schema-expected" ]; then echo "Nextcloud schema expected but $DB/oc_appconfig is missing"; exit 1; fi
exit 0
