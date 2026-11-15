#!/bin/sh
# hooks/backup-db-clean.sh — postHook step 2 of x-app.backup (idea#403), runs in nextcloud-db.
#
#   docker compose exec -T -- nextcloud-db /idea/backup/db-clean.sh
#
# Removes the dump written by backup-db-dump.sh after borg has read it (or after a
# failed dump), its two import markers, and the backup-pending marker the app healthcheck
# uses (app-nextcloud#29). Only these files are removed, never a folder. Idempotent:
# exit 0 when they are already gone.
set -eu
DIR="${IDEA_BACKUP_DB_DIR:-/docker-entrypoint-initdb.d}"
[ -d "$DIR" ] || exit 0
rm -f "$DIR/nextcloud.sql" "$DIR/.nextcloud.sql.tmp" "$DIR/nextcloud.sql.id" "$DIR/nextcloud.sql.id.tmp" \
	"$DIR/00-idea-import-begin.sh" "$DIR/zz-idea-import-end.sh" \
	"$DIR/00-idea-import-begin.sh.tmp" "$DIR/zz-idea-import-end.sh.tmp" \
	"$DIR/.idea-backup-pending"
echo "backup-db-clean: ok" >&2
