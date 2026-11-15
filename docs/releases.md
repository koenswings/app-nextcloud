# Releases

Tags are set by the Lead bot on the merged release commit (`<IDEA major>.<minor>-<Nextcloud version>`).
Kits get a release only through Engine `updateApp` (idea#374). Every release so far keeps the
same pinned images, so no image is rebuilt or republished.

## 1.7-31.0.1

- **Healthcheck during backup** (app-nextcloud#29): the `nextcloud-app` Docker healthcheck treats
  maintenance mode as alive only while an IDEA backup is in progress
  (`data/nextcloud/data/.idea-backup-pending`, written by the preHook `touch`, removed by
  postHook and by `00-idea-restore.sh` on every start) and the marker's age (`now - mtime`) is
  in `[-300, 7200]` seconds (`IDEA_BACKUP_MARKER_MAX_FUTURE_S` default 300,
  `IDEA_BACKUP_MARKER_MAX_AGE_S` default 7200). HTTP 200 with
  `"maintenance":false,"needsDbUpgrade":false` stays the ready path; HTTP 200 or 503 with
  `"maintenance":true` (Nextcloud 31 answers 200) is accepted only with a fresh marker, so a failed postHook, a manual
  `occ maintenance:mode --on`, a leftover older than 2 h, or a mtime more than 5 min in the
  future still goes unhealthy. `hookExclude` lists the marker so it never lands in a hook
  archive. `x-app.healthCheck` is unchanged (updateApp still waits for maintenance off).
- **Images** unchanged since 1.2 (same digests).

**Migration:** none. A leftover dump-dir marker from earlier #29 tips is removed by
`db-clean.sh`; the live marker is in the Nextcloud data dir.

**Tested:** `node --test tests/` on the box. A Pi check should still prove: a hook backup whose
dump+borg window exceeds about 45 s leaves `nextcloud-app` healthy; after postHook the marker is
gone and the app stays healthy; maintenance left on with no marker goes unhealthy; maintenance
on with a marker more than 2 h old, or more than 5 min in the future, goes unhealthy; a restart
with a leftover marker clears it.

## 1.6-31.0.1

- **Live backup** (idea#403, agent-engine-dev#404): `x-app.backup` method `hook`, fallback `stop`,
  `hookTimeout` 600 s per step. preHook: maintenance mode on, then a MariaDB dump
  (`--single-transaction`) into `data/backup/db`; postHook: maintenance off, dump, id and import markers removed.
  `hookExclude: [data/db]`. See [backup.md](./backup.md).
- **Restore of a hook archive**: `./data/backup/db` is MariaDB's initdb folder, so an empty datadir
  imports the dump. New db healthcheck (the image's `healthcheck.sh --connect --innodb_initialized`) with
  `MARIADB_AUTO_UPGRADE=1`, which creates the healthcheck user on an existing data dir, and
  `depends_on: service_healthy` on `nextcloud-app`. New `before-starting/00-idea-restore.sh`:
  maintenance off before Apache, then a detached `files:scan --all` once Apache answers, once per dump.
  A broken dump import fails closed: initdb markers leave `data/db/.idea-import-pending` and the db
  healthcheck stays unhealthy on it (move `data/db` aside and start again).
- **Images** unchanged since 1.2 (same digests).

**Migration:** none. On the first start of 1.6 Docker creates the empty `data/backup/db` folder,
and the MariaDB entrypoint (`MARIADB_AUTO_UPGRADE=1`) creates the `healthcheck` user and
`data/db/.my-healthcheck.cnf` when they are missing (a few seconds, temporary server).
The app now starts only once MariaDB answers on TCP (a few seconds on a normal start).

**Tested:** `engine_tested` 721f0fa, Engine-path Pi proof on idea03 (2026-11-15, app at f08a2a8, throwaway instance on Disk B): `backupApp` ran the hook (maintenance on, db-dump, maintenance off, db-clean; no stop, maintenance window about 21 s), `listBackup` and `verifyBackup` passed, and an in-place `restoreApp` imported the dump, ran the `files:scan` worker (done marker written) and brought back the deleted file, share and user.

## 1.5-31.0.1

Since the last tag, `1.2-31.0.1` (0a6e764). 1.3 and 1.4 were version bumps on main and were never tagged.

- **Usage hook** (idea#413, 1.3): `x-app.usage` → `/hooks/usage.sh` day summaries for the
  usage dashboard: setup and logins per group, Office opens, shares and File drop.
- **Shares and File drop by group** (idea#431, 1.4).
- **Apps opened and documents created** (idea#464, 1.5): the bundled `idea_usage` 1.0.0 app
  (`bundled-apps/`, enabled by `25-idea-usage.sh`) counts full-page app opens per day, group
  and app in `oc_idea_usage_apps_opened`. The hook adds `appsOpened`, `appsOpenedByGroup`
  and `documents{created, byGroup}` (omitted when the activity app is off).
- **Empty skeleton** (idea#464, #22 and #23): `config/idea-skeleton.config.php` sets
  `skeletondirectory` and `templatedirectory` to empty, and `05-idea-skeleton-config.sh`
  copies it into Nextcloud's `config/` **before `maintenance:install`** (and on every later
  start). No account gets example files, including the install-time `admin`, so a fresh
  install starts at `documents.created` 0 and the count covers only real work.
  `26-idea-skeleton.sh` stays as an `occ` fallback. Existing users' files are never touched.
- **Images by digest** (idea#322): `koenswings/nextcloud:1.0-31.0.1`,
  `koenswings/nextcloud-mariadb:1.0-11.7.2-MariaDB-ubu2404`, `koenswings/nextcloud-code:1.0-24.04.13.2`,
  all linux/arm64, unchanged since 1.2.

**Migration:** none beyond Nextcloud's own first start. Nextcloud stays on 31.0.1, so there is
no database upgrade. On the first start of 1.5 the before-starting hooks enable `idea_usage`
(its migration creates the counter table) and put the empty-skeleton config file in place
(the new `./config:/idea-config:ro` bind). Files and accounts are kept.

**Tested:** `engine_tested` 431ab4c, 7-step on-Pi check (steps 1–6 on idea04, step 7 on idea03; app 1.5-31.0.1 at af5f289). Earlier checks on idea03 at c460aca, 1224f54 and 3fa97b1 (app-nextcloud#22, #23).
