# Live backup (`x-app.backup` method `hook`, idea#403)

Nextcloud 1.7 is backed up while it runs. The Engine contract is
[agent-engine-dev#404](https://github.com/koenswings/agent-engine-dev/pull/404); the App-author
contract is `docs/backup-hook.md` in agent-app-dev.

## What the Engine runs

Each step is `timeout --signal=TERM --kill-after=10s 600 docker compose exec -T [--user U] -- <service> <argv…>`
from the instance folder: no shell and no extra env. `hookTimeout` (600 s) applies per step.

| Step | Service | Command | Does |
|------|---------|---------|------|
| preHook[0] | nextcloud-app (user 33) | `touch /var/www/html/data/.idea-backup-pending` | Marker for the app healthcheck (host: `data/nextcloud/data/.idea-backup-pending`) |
| preHook[1] | nextcloud-app (user 33) | `php /var/www/html/occ maintenance:mode --on` | No writes from the web UI, WebDAV or background jobs |
| preHook[2] | nextcloud-db | `/idea/backup/db-dump.sh` | `mariadb-dump --single-transaction` of `nextcloud` into `data/backup/db/nextcloud.sql` (+ `nextcloud.sql.id` and the import markers) |
| *borg* | — | instance folder minus `data/db` (`hookExclude`) | |
| postHook[0] | nextcloud-app (user 33) | `rm -f /var/www/html/data/.idea-backup-pending` | Marker removed first, so a failed `maintenance:off` still goes unhealthy; idempotent |
| postHook[1] | nextcloud-app (user 33) | `php /var/www/html/occ maintenance:mode --off` | Idempotent |
| postHook[2] | nextcloud-db | `/idea/backup/db-clean.sh` | Removes the dump (`nextcloud.sql`), its id (`nextcloud.sql.id`), the two import markers (`00-idea-import-begin.sh`, `zz-idea-import-end.sh`), plus their temp files, and a leftover dump-dir marker from earlier tips; idempotent |

Pre steps stop at the first failure. Every post step always runs: after a failed pre step, after a
failed earlier post step and after a failed borg run. So maintenance mode is switched off even when
the dump fails. Nextcloud is in maintenance mode for the whole run (pre, borg, post).

A failed pre step (any non-zero exit or a timeout): postHook, then `fallback: stop` (a normal
stop/start backup with `data/db`, result `HOOK_FALLBACK`). updateApp's pre-update backup forces
`fail` (idea#448). A stopped instance gets a cold backup: hooks are skipped, `data/db` is kept.

## Healthcheck during the backup window (app-nextcloud#29)

`status.php` returns HTTP 503 with `"maintenance":true` while maintenance is on, so the old
`curl -f` healthcheck failed for the whole window. With interval 15 s and 3 retries, a dump+borg
run longer than about 45 s (a large database or a slow Backup Disk) would mark `nextcloud-app`
unhealthy mid-backup.

The Docker healthcheck (`hooks/app-healthcheck.sh`, mounted at `/idea/app-healthcheck.sh`) now
treats that window as alive, but only while the backup marker exists:

- HTTP 200 and a body containing `"maintenance":false,"needsDbUpgrade":false`: healthy (ready).
- HTTP 503, a body containing `"maintenance":true`, and `data/nextcloud/data/.idea-backup-pending`
  (`/var/www/html/data/.idea-backup-pending` in the app container) whose age
  (`now - mtime`) is in `[-300, 7200]` seconds (`IDEA_BACKUP_MARKER_MAX_FUTURE_S` default 300,
  `IDEA_BACKUP_MARKER_MAX_AGE_S` default 7200): healthy (backup in progress).
  preHook `touch`es the marker (mtime is "now") before maintenance is turned on; postHook
  removes it first, then turns maintenance off (every postHook step always runs).
  A leftover marker older than 2 h, or more than 5 min in the future (a Pi with no RTC
  and no NTP after a reboot), counts as absent, so stuck maintenance goes unhealthy.
  A small backward NTP step (within 5 min) still allows a live backup.
- Anything else, including maintenance with no marker (a failed postHook that left maintenance
  on, or a manual `occ maintenance:mode --on`): unhealthy.

The marker lives in the Nextcloud data dir so `before-starting/00-idea-restore.sh` can
remove it on every start (www-data can write there). The dump folder is mounted
read-only in the app container, so a marker there could not be cleared on start.
`hookExclude` lists `data/nextcloud/data/.idea-backup-pending` so the marker never
lands in a hook archive (and so a restore cannot put a leftover back).
A live hook backup cannot race that start cleanup: the hook only runs from the image
entrypoint on `compose up`, and `backupApp` only `docker compose exec`s into already-running
containers (it never restarts them). A stopped instance gets a cold backup (hooks skipped,
no marker written).

`x-app.healthCheck` is unchanged. After start or restore the Engine's port-ready check
(`assertInstancePortReady`) already accepts any HTTP status, including Nextcloud's 503.
updateApp's Health step waits until Docker is up and then probes `x-app.healthCheck`, which
still requires HTTP 2xx/3xx and `"maintenance":false,"needsDbUpgrade":false`, so an upgrade
still in maintenance does not pass.

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
fake `mariadb-dump`, the restore hook with `tests/fake-occ-restore.mjs`;
`tests/app-healthcheck.test.mjs`: ready, maintenance with a fresh marker, without it, a marker older than 2 h, the 2 h boundary, a future mtime within 300 s and beyond it, and down).
