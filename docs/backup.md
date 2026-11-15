# Live backup (`x-app.backup` method `hook`, idea#403)

Nextcloud 1.6 is backed up while it runs. The Engine contract is
[agent-engine-dev#404](https://github.com/koenswings/agent-engine-dev/pull/404); the App-author
contract is `docs/backup-hook.md` in agent-app-dev.

## What the Engine runs

Each step is `timeout --signal=TERM --kill-after=10s 600 docker compose exec -T [--user U] -- <service> <argv…>`
from the instance folder: no shell and no extra env. `hookTimeout` (600 s) applies per step.

| Step | Service | Command | Does |
|------|---------|---------|------|
| preHook[0] | nextcloud-app (user 33) | `php /var/www/html/occ maintenance:mode --on` | No writes from the web UI, WebDAV or background jobs |
| preHook[1] | nextcloud-db | `/idea/backup/db-dump.sh` | `mariadb-dump --single-transaction` of `nextcloud` into `data/backup/db/nextcloud.sql` (+ `nextcloud.sql.id` and the import markers) |
| *borg* | — | instance folder minus `data/db` (`hookExclude`) | |
| postHook[0] | nextcloud-app (user 33) | `php /var/www/html/occ maintenance:mode --off` | Idempotent |
| postHook[1] | nextcloud-db | `/idea/backup/db-clean.sh` | Removes the dump (`nextcloud.sql`), its id (`nextcloud.sql.id`) and the two import markers (`00-idea-import-begin.sh`, `zz-idea-import-end.sh`), plus their temp files; idempotent |

Pre steps stop at the first failure. Every post step always runs: after a failed pre step, after a
failed earlier post step and after a failed borg run. So maintenance mode is switched off even when
the dump fails. Nextcloud is in maintenance mode for the whole run (pre, borg, post).

A failed pre step (any non-zero exit or a timeout): postHook, then `fallback: stop` (a normal
stop/start backup with `data/db`, result `HOOK_FALLBACK`). updateApp's pre-update backup forces
`fail` (idea#448). A stopped instance gets a cold backup: hooks are skipped, `data/db` is kept.

## The dump

`hooks/backup-db-dump.sh` runs as root in the MariaDB container. The root password comes from the
container env (`MYSQL_ROOT_PASSWORD`, the instance `pass`) and is passed only through `MYSQL_PWD`;
it is never on argv or printed. The dump is written to a temp file and renamed only when it ends
with `-- Dump completed` and has the `oc_filecache` table. An older dump, its id and its markers are removed
first, so a failed run never leaves a dump behind. Options: `--single-transaction --quick --routines --triggers
--hex-blob --default-character-set=utf8mb4`, database only (no `CREATE DATABASE`).

`./data/backup/db` is bound as MariaDB's `/docker-entrypoint-initdb.d`. The official MariaDB
entrypoint imports `*.sql` from there **only when the datadir is empty**, so on a normal start
(data/db present) a leftover dump is ignored.

## Restore

`restoreApp` puts the instance folder back; it does not apply dumps. The App does:

1. **Hook archive** (no `data/db`, dump in `data/backup/db`): MariaDB initializes an empty datadir
   (same `.env`, so same passwords) and imports the dump with its temporary server. That server
   has skip-networking, so the db healthcheck (the image's `healthcheck.sh --connect
   --innodb_initialized`, as its healthcheck user from `data/db/.my-healthcheck.cnf`; no password
   in compose, no access-denied log lines) only turns healthy after
   the import. `nextcloud-app` has `depends_on: nextcloud-db: service_healthy`, so Nextcloud
   starts after the import (`start_period` 900 s covers a large import).
2. `before-starting/00-idea-restore.sh` (first hook, as www-data) sees a dump id without a done
   marker. It only does the quick part before Apache: `occ maintenance:mode --off` (config.php
   was archived with maintenance on), then starts a detached worker (`setsid "$0" --scan-worker
   <id> &`) and exits. So the hook does not use up the port-ready budget (`x-app.healthTimeout`
   300 s), however many files the restore has.
3. The worker survives the hook and the exec of Apache. It polls `http://127.0.0.1/status.php`
   (every 5 s, up to 1 h) until it answers `installed:true` and `maintenance:false`, then runs
   `occ files:scan --all`. On success it writes the done marker. Until the scan is done the
   file cache can lag the files on disk; users can already log in.
   Files in the container (on the disk under `data/nextcloud/data/`):
   - `/var/www/html/data/.idea-restore-id`: done marker, the dump id;
   - `/var/www/html/data/.idea-restore-scan.log`: worker log (wait time, scan result);
   - `/var/www/html/data/.idea-restore-scan.running`: a worker runs in this container.
   Once per dump id: no marker means try again. A crash, failed scan or timeout leaves no
   marker, and the next start clears a leftover `.running` and tries again. The hook always exits 0.
4. **Fallback or cold archive** (`data/db` present): a normal start; any dump in the archive is ignored.

### A broken import fails closed

Next to the dump, `db-dump.sh` writes two small initdb files that MariaDB's entrypoint sources
in glob order around `nextcloud.sql`: `00-idea-import-begin.sh` creates
`data/db/.idea-import-pending`, `zz-idea-import-end.sh` removes it. `db-clean.sh` removes both
with the dump. If the import stops part-way (power cut, full disk, OOM, a bad statement), the
first start exits with the error and the marker stays. On the next start MariaDB sees an
existing database and does not import again, but the db healthcheck
(`[ ! -e /var/lib/mysql/.idea-import-pending ] && healthcheck.sh …`) refuses, so the db never
turns healthy, Nextcloud (`depends_on: service_healthy`) never starts on the partial database,
and the start ends in Error once `start_period` (900 s) and the retries are used up.

**A pending marker means the import broke: move `data/db` aside and start again** (the dump in
`data/backup/db` is imported into the new empty datadir). The markers do nothing on a normal
start or during a live backup: initdb files only run on an empty datadir.

## verify

`verify.present` lists only paths true of every archive type until engine#401 adds per-mode
checks: `.env`, `data/nextcloud/config/config.php`, `data/nextcloud/version.php`,
`hooks/backup-db-dump.sh`. `data/db` is absent only in a hook archive, so it is not listed.

## Tests

`node --test tests/*.test.mjs` (`tests/backup-hook.test.mjs`: compose block, dump/clean with a
fake `mariadb-dump`, the restore hook with `tests/fake-occ-restore.mjs`).
