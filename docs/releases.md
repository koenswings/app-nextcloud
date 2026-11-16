# Releases

Tags are set by the Lead bot on the merged release commit (`<IDEA major>.<minor>-<Nextcloud version>`).
Kits get a release only through Engine `updateApp` (idea#374). Until a Nextcloud image
is retagged and published (Koen YES), `nextcloud-app` is pinned to the official upstream
index; MariaDB and CODE stay on the same pins as 1.2.

## 4.0-34.0.6

**DRAFT** (draft PR; path agreed in idea#548, merged 2026-11-15). Pi proof pending (pool
reserved). No image publish, no tag. Stacked on the 3.0-33.0.11 draft.

- **Nextcloud major hop:** official `library/nextcloud` `33.0.11-apache` → `34.0.6-apache`
  (latest 34.0.x as of 2026-11-15). App major 3.0 → 4.0. Bundle name `nextcloud-4.0-34.0.6`.
  `x-app.updatesFrom: [3]` (repo convention: a list of App majors; 3 covers the 3.x line
  including 3.0-33.0.11). 4.0 does not list 2 or 1: Nextcloud cannot skip majors, and a
  2.0 (Nextcloud 32) or 1.8 (Nextcloud 31) → 4.0 (Nextcloud 34) jump would be refused.
  Axle's chained path is a sequence of such hops; each hop still has to pass `updatesFrom`
  on its own.
- **Images:** `nextcloud-app` is pinned to the upstream multi-platform index
  `nextcloud:34.0.6-apache@sha256:3031e7f87baaceb863a755921ebf463bc26ea71855c07ad7858e2ae25a5a0ad7`
  (`linux/arm64` variant v8 is in the index, platform manifest
  `sha256:f01db3987605b0d69905b13e88f55fc84e68a5c202aaa3985af861aad19d5354`; base
  `php:8.5-apache-trixie`). The usual IDEA retag `koenswings/nextcloud:4.0-34.0.6` is
  not published yet (needs Koen YES). check-compose and the Engine pin
  check (`saveName()`, idea#322) require `repo:tag@sha256:<64 hex>` — a digest-only pin
  and an unpublished placeholder are both refused — so the compose uses the published
  official tag+index digest until the retag exists and the pin is swapped. MariaDB
  (`koenswings/nextcloud-mariadb:1.0-11.7.2-MariaDB-ubu2404`) and CODE
  (`koenswings/nextcloud-code:1.0-24.04.13.2`) are unchanged since 1.2. The 11.8 MariaDB
  move is **not** in this hop (idea#548 Q9: separate hop once 33 is healthy, with
  `MARIADB_AUTO_UPGRADE=1`). `serverid` / `NC_serverid` stays unset
  (a stable value is a later item).
- **bundled apps:** `richdocuments` 11.1.3 (`info.xml` min-version 34, max-version 34).
  `idea_usage` stays 1.0.0 with the Nextcloud range widened to min-version 31, max-version 34
  (version bump to 1.0.1 is deferred to the release decision). 10.3.3 is not shipped: a
  fresh 34 install would otherwise extract the 33-only tarball first.
- **Prepare hook:** `x-app.update.prepare` runs `hooks/prep-custom-apps-for-upgrade.sh`
  after Swap and before Start as a one-off (Axle addendum). The Engine uses a generated
  override (`entrypoint: [command]`, empty command, no leftover argv):
  `docker compose run --rm --no-deps --no-TTY --user 0 nextcloud-app`. `user: "0"` is
  declared (gaps 10 and 13 accepted). The script is idempotent as a defensive rule
  (SHA256SUMS, mv backups, no occ; an interrupted prepare always restores the snapshot)
  and reads target versions from the tarballs.
- **Verify hook:** `x-app.update.verify` runs `hooks/verify-update.sh` once after Health
  (`docker compose exec -T -u 33`; timeout 120). Exit 0 passes; any other exit is
  `VERIFY_FAILED` and rolls back. Checks `status.php` (installed, maintenance false,
  needsDbUpgrade false) and `occ app:list` showing richdocuments 11.1.3 or newer enabled and
  idea_usage 1.0.0 enabled. Versions come from the bundled tarball / `hooks/update-targets`
  (keyed by `IDEA_APP_VERSION`, which matches `x-app.version`).
- **Work hook:** `x-app.update.work` runs `hooks/work-update.sh` once after verify
  (`docker compose exec -T -u 33`; timeout 3600). It runs `cron.php` up to three times
  (Nextcloud: run it 2-3 times after a major). A non-zero exit or timeout stops the path
  with `migrationsPending` and does not roll back.
- **Settle check:** `x-app.update.settle` runs `hooks/settle-update.sh` after work
  (`docker compose exec -T -u 33`; exit 0 settled, 3 not yet, other error; interval 60,
  timeout 3600). `user: "33"` is declared (no in-script root→www-data fallback).
  Read-only: `status.php` plus a pending-upgrade-job probe. It does not run `cron.php`
  and does not re-check app versions (that is verify's job, because it rolls back).
- **healthTimeout:** 600 s (desk estimate for a major hop; `start_period` matches).
  Re-measure on a pool Pi before locking the release.
- **Admin-facing breaking changes (idea#548 Q4):** desk research in idea#548 §8.5.
  The admin manual has no "Upgrade to Nextcloud 34" critical-changes page; Nextcloud
  maintainers say there are no critical admin changes. PHP 8.5 is provided by the official
  image. See idea#548 §8.5 for shipped apps (`office`, `files_lock`, `appstore`) and API notes.
- **App store pin and richdocuments >= rule (2026-11-16):** prepare sets
  `appstoreenabled=false` before `occ upgrade` and settle restores the previous value once
  settled; verify accepts richdocuments at the pinned version or newer (semver compare).
  Details, state file and rollback behaviour: "App store pin (update stages, 2.0 and later)"
  at the end of this file.

**Migration:** Nextcloud's own database upgrade on the first start of 4.0 (33.0.11 →
34.0.6), after Prepare has staged the new apps. Files and accounts are kept.
Nextcloud is in maintenance mode until the upgrade has finished. MariaDB and CODE
are unchanged.

**Database:** no database image upgrade in this release. MariaDB stays
`koenswings/nextcloud-mariadb:1.0-11.7.2-MariaDB-ubu2404` (idea#548 Q9: the MariaDB 11.8
upgrade is a separate release, app-nextcloud#31). Nextcloud 34's setup check accepts
MariaDB 10.6–11.8; only Nextcloud's own schema upgrade runs.

**Tested:** unit tests and agent-app-dev `check-compose --release` pass on the box. Pi proof
pending (pool reserved; also needs the Engine prepare/verify/work/settle steps). `engine_tested`
is left at the 1.7 value (cba91a6) until that proof.

## 3.0-33.0.11

**DRAFT** (draft PR; path agreed in idea#548, merged 2026-11-15). Pi proof pending (pool
reserved). No image publish, no tag. Stacked on the 2.0-32.0.15 draft.

- **Nextcloud major hop:** official `library/nextcloud` `32.0.15-apache` → `33.0.11-apache`
  (latest 33.0.x as of 2026-11-15). App major 2.0 → 3.0. Bundle name `nextcloud-3.0-33.0.11`.
  `x-app.updatesFrom: [2]` (repo convention: a list of App majors; 2 covers the 2.x line
  including 2.0-32.0.15). 3.0 does not list 1: Nextcloud cannot skip majors, and a 1.8
  (Nextcloud 31) → 3.0 (Nextcloud 33) jump would be refused. Axle's chained path is a
  sequence of such hops; each hop still has to pass `updatesFrom` on its own.
- **Images:** `nextcloud-app` is pinned to the upstream multi-platform index
  `nextcloud:33.0.11-apache@sha256:3bbb8b04c6ea1b6687502802f9097fd9723797668a9dd6d0adcf4525b530f7a1`
  (`linux/arm64` variant v8 is in the index, platform manifest
  `sha256:504714d8dac82e8ceabd0cd9ede179a92b0db3a5ae4f85e26ec13e8d36ac7739`; base
  `php:8.4-apache-trixie`). The usual IDEA retag `koenswings/nextcloud:3.0-33.0.11` is
  not published yet (needs Koen YES). check-compose and the Engine pin
  check (`saveName()`, idea#322) require `repo:tag@sha256:<64 hex>` — a digest-only pin
  and an unpublished placeholder are both refused — so the compose uses the published
  official tag+index digest until the retag exists and the pin is swapped. MariaDB
  (`koenswings/nextcloud-mariadb:1.0-11.7.2-MariaDB-ubu2404`) and CODE
  (`koenswings/nextcloud-code:1.0-24.04.13.2`) are unchanged since 1.2. The 11.8 MariaDB
  move is **not** in this hop (idea#548 §8.2).
- **bundled apps:** `richdocuments` 10.3.3 (`info.xml` min-version 33, max-version 33).
  `idea_usage` stays 1.0.0 with the Nextcloud range widened to min-version 31, max-version 33
  (version bump to 1.0.1 is deferred to the release decision). 9.2.3 is not shipped: a
  fresh 33 install would otherwise extract the 32-only tarball first.
- **Prepare hook:** `x-app.update.prepare` runs `hooks/prep-custom-apps-for-upgrade.sh`
  after Swap and before Start as a one-off (Axle addendum). The Engine uses a generated
  override (`entrypoint: [command]`, empty command, no leftover argv):
  `docker compose run --rm --no-deps --no-TTY --user 0 nextcloud-app`. `user: "0"` is
  declared (gaps 10 and 13 accepted). The script is idempotent as a defensive rule
  (SHA256SUMS, mv backups, no occ; an interrupted prepare always restores the snapshot)
  and reads target versions from the tarballs.
- **Verify hook:** `x-app.update.verify` runs `hooks/verify-update.sh` once after Health
  (`docker compose exec -T -u 33`; timeout 120). Exit 0 passes; any other exit is
  `VERIFY_FAILED` and rolls back. Checks `status.php` (installed, maintenance false,
  needsDbUpgrade false) and `occ app:list` showing richdocuments 10.3.3 or newer enabled and
  idea_usage 1.0.0 enabled. Versions come from the bundled tarball / `hooks/update-targets`
  (keyed by `IDEA_APP_VERSION`, which matches `x-app.version`).
- **Work hook:** `x-app.update.work` runs `hooks/work-update.sh` once after verify
  (`docker compose exec -T -u 33`; timeout 3600). It runs `cron.php` up to three times
  (Nextcloud: run it 2-3 times after a major). A non-zero exit or timeout stops the path
  with `migrationsPending` and does not roll back.
- **Settle check:** `x-app.update.settle` runs `hooks/settle-update.sh` after work
  (`docker compose exec -T -u 33`; exit 0 settled, 3 not yet, other error; interval 60,
  timeout 3600). `user: "33"` is declared (no in-script root→www-data fallback).
  Read-only: `status.php` plus a pending-upgrade-job probe. It does not run `cron.php`
  and does not re-check app versions (that is verify's job, because it rolls back).
- **healthTimeout:** 600 s (desk estimate for a major hop; `start_period` matches).
  Re-measure on a pool Pi before locking the release.
- **Snowflake `serverid` and MariaDB 11.8:** desk research in idea#548 §8.2 and §8.4. 33 does not
  require a configured `serverid` to upgrade (admin overview info only); this draft does
  not set one. MariaDB stays on 11.7.2.
- **App store pin and richdocuments >= rule (2026-11-16):** prepare sets
  `appstoreenabled=false` before `occ upgrade` and settle restores the previous value once
  settled; verify accepts richdocuments at the pinned version or newer (semver compare).
  Details, state file and rollback behaviour: "App store pin (update stages, 2.0 and later)"
  at the end of this file.

**Migration:** Nextcloud's own database upgrade on the first start of 3.0 (32.0.15 →
33.0.11), after Prepare has staged the new apps. Files and accounts are kept.
Nextcloud is in maintenance mode until the upgrade has finished. MariaDB and CODE
are unchanged.

**Database:** no database image upgrade in this release. MariaDB stays
`koenswings/nextcloud-mariadb:1.0-11.7.2-MariaDB-ubu2404` (idea#548 Q9: the MariaDB 11.8
upgrade is a separate release, app-nextcloud#31). Nextcloud 33's setup check accepts
MariaDB 10.6–11.8; only Nextcloud's own schema upgrade runs.

**Tested:** unit tests and agent-app-dev `check-compose --release` pass on the box. Pi proof
pending (pool reserved; also needs the Engine prepare/verify/work/settle steps). `engine_tested`
is left at the 1.7 value (cba91a6) until that proof.

## 2.0-32.0.15

**DRAFT** (draft PR; path agreed in idea#548, merged 2026-11-15). Pi proof pending (pool
reserved). No image publish, no tag.

- **Nextcloud major hop:** official `library/nextcloud` `31.0.14-apache` → `32.0.15-apache`
  (latest 32.0.x as of 2026-11-15). App major 1.8 → 2.0. Bundle name `nextcloud-2.0-32.0.15`.
  `x-app.updatesFrom: [1]` (repo convention: a list of App majors; 1 covers the 1.x line
  including 1.8-31.0.14). Nextcloud cannot skip majors.
- **Images:** `nextcloud-app` is pinned to the upstream multi-platform index
  `nextcloud:32.0.15-apache@sha256:db18aaa3a58302d7363dc59905c310f6df5141800bc8f336ab9cdec5577c6211`
  (`linux/arm64` variant v8 is in the index, platform manifest
  `sha256:3c169716aff4acde4f809c0c522d9c0b95c15b86832685614fe7909adbe6c17f`). The usual IDEA
  retag `koenswings/nextcloud:2.0-32.0.15` is not published yet (needs Koen YES). check-compose and the Engine pin check (`saveName()`, idea#322) require
  `repo:tag@sha256:<64 hex>` — a digest-only pin and an unpublished placeholder are both
  refused — so the compose uses the published official tag+index digest until the retag
  exists and the pin is swapped. MariaDB
  (`koenswings/nextcloud-mariadb:1.0-11.7.2-MariaDB-ubu2404`) and CODE
  (`koenswings/nextcloud-code:1.0-24.04.13.2`) are unchanged since 1.2.
- **bundled apps:** `richdocuments` 9.2.3 (`info.xml` min-version 32, max-version 32).
  `idea_usage` stays 1.0.0 with the Nextcloud range widened to min-version 31, max-version 32
  (version bump to 1.0.1 is deferred to the release decision). 8.8.3 is not shipped: a
  fresh 32 install would otherwise extract the 31-only tarball first.
- **Prepare hook:** `x-app.update.prepare` runs `hooks/prep-custom-apps-for-upgrade.sh`
  after Swap and before Start as a one-off (Axle addendum). The Engine uses a generated
  override (`entrypoint: [command]`, empty command, no leftover argv):
  `docker compose run --rm --no-deps --no-TTY --user 0 nextcloud-app`. `user: "0"` is
  declared (gaps 10 and 13 accepted). The script is idempotent as a defensive rule
  (SHA256SUMS, mv backups, no occ; an interrupted prepare always restores the snapshot)
  and reads target versions from the tarballs.
- **Verify hook:** `x-app.update.verify` runs `hooks/verify-update.sh` once after Health
  (`docker compose exec -T -u 33`; timeout 120). Exit 0 passes; any other exit is
  `VERIFY_FAILED` and rolls back. Checks `status.php` (installed, maintenance false,
  needsDbUpgrade false) and `occ app:list` showing richdocuments 9.2.3 or newer enabled and
  idea_usage 1.0.0 enabled. Versions come from the bundled tarball / `hooks/update-targets`
  (keyed by `IDEA_APP_VERSION`, which matches `x-app.version`).
- **Work hook:** `x-app.update.work` runs `hooks/work-update.sh` once after verify
  (`docker compose exec -T -u 33`; timeout 3600). It runs `cron.php` up to three times
  (Nextcloud: run it 2-3 times after a major). A non-zero exit or timeout stops the path
  with `migrationsPending` and does not roll back.
- **Settle check:** `x-app.update.settle` runs `hooks/settle-update.sh` after work
  (`docker compose exec -T -u 33`; exit 0 settled, 3 not yet, other error; interval 60,
  timeout 3600). `user: "33"` is declared (no in-script root→www-data fallback).
  Read-only: `status.php` plus a pending-upgrade-job probe. It does not run `cron.php`
  and does not re-check app versions (that is verify's job, because it rolls back).
- **healthTimeout:** 600 s (desk estimate for a major hop; `start_period` matches).
  Re-measure on a pool Pi before locking the release.
- **App store pin and richdocuments >= rule (2026-11-16):** prepare sets
  `appstoreenabled=false` before `occ upgrade` and settle restores the previous value once
  settled; verify accepts richdocuments at the pinned version or newer (semver compare).
  Details, state file and rollback behaviour: "App store pin (update stages, 2.0 and later)"
  at the end of this file.

**Migration:** Nextcloud's own database upgrade on the first start of 2.0 (31.0.14 →
32.0.15), after Prepare has staged the new apps. Files and accounts are kept.
Nextcloud is in maintenance mode until the upgrade has finished. MariaDB and CODE
are unchanged.

**Database:** no database image upgrade in this release. MariaDB stays
`koenswings/nextcloud-mariadb:1.0-11.7.2-MariaDB-ubu2404` (idea#548 Q9: the MariaDB 11.8
upgrade is a separate release, app-nextcloud#31). Nextcloud 32's setup check accepts
MariaDB 10.6–11.8; only Nextcloud's own schema upgrade runs.

**Tested:** unit tests and agent-app-dev `check-compose --release` pass on the box. Pi proof
pending (pool reserved; also needs the Engine prepare/verify/work/settle steps). `engine_tested`
is left at the 1.7 value (cba91a6) until that proof.

## 1.8-31.0.14

- **Nextcloud point update:** official `library/nextcloud` `31.0.1-apache` → `31.0.14-apache`
  (latest 31.0.x patch as of 2026-11-15; floating `31-apache` and `31.0-apache` point at the
  same index). App minor 1.7 → 1.8, same App major, same Nextcloud major 31. Bundle name
  `nextcloud-1.8-31.0.14`.
- **Images:** `nextcloud-app` is pinned to the upstream multi-platform index
  `nextcloud:31.0.14-apache@sha256:07ec73cc816e58d6f45a162cd53ef886462c29271a23fc68d0124cec276e3767`
  (`linux/arm64` variant v8 is in the index, platform manifest
  `sha256:cfd9217bf40573a3cef513e32be7ac2517b3f57dc597eddbe4d2e81b0271c526`). The usual IDEA
  retag `koenswings/nextcloud:1.8-31.0.14` is not published yet (needs Koen YES).
  check-compose and the Engine pin check (`saveName()`, idea#322) require
  `repo:tag@sha256:<64 hex>` — a digest-only pin and an unpublished placeholder are both
  refused — so the compose uses the published official tag+index digest until the retag
  exists and the pin is swapped. MariaDB
  (`koenswings/nextcloud-mariadb:1.0-11.7.2-MariaDB-ubu2404`) and CODE
  (`koenswings/nextcloud-code:1.0-24.04.13.2`) are unchanged since 1.2.
- **bundled apps:** `richdocuments` stays 8.8.3 (`info.xml` min-version 31, max-version 31,
  covers 31.0.14). `idea_usage` 1.0.0 stays (`info.xml` range 31). Tarball checksums in
  `bundled-apps/SHA256SUMS` are unchanged.

**Migration:** Nextcloud's own database upgrade on the first start of 1.8 (31.0.1 → 31.0.14).
Files and accounts are kept. Nextcloud is in maintenance mode until the upgrade has finished.
No App-level migration. MariaDB and CODE are unchanged.

**Tested:** Pi proof on idea04 (Raspberry Pi 4), Engine 0038e31, 15 November 2026 (rerun).
`updateApp` 1.7-31.0.1 → 1.8-31.0.14, trace `4b9b6c17-bde0-4394-bdd6-f86e713a8fde`, status ok
(Fetch, Check, Snapshot, Swap, Start, Health). About 3¼ minutes of downtime: 193–196 s from the
container stop to the first `status.php` 200 / Docker healthy, 205 s to Engine Running (one run,
small test school). Post-update checks passed (31.0.14, maintenance false, needsDbUpgrade
false, richdocuments 8.8.3 and idea_usage 1.0.0 enabled, login per role, file checksums,
Office open), and so did backup, list, verify and restore (the same checks passed again after
the restore). Run 1 (Engine d366432) failed on engine#447 (Swap could not overwrite the
bundle's relative symlinks) and rolled back automatically to 1.7-31.0.1 with its data.
`engine_tested` in `app.yaml` is still the 1.7 value (cba91a6).

**Tags:** git tags `1.7-31.0.1` (1c8247b) and `1.8-31.0.14` (6a48eca) now exist.

## 1.7-31.0.1

- **Healthcheck during backup** (app-nextcloud#29): the `nextcloud-app` Docker healthcheck treats
  maintenance mode as alive only while an IDEA backup is in progress
  (`data/nextcloud/data/.idea-backup-pending`, written by the preHook `touch`, removed by
  postHook and by `00-idea-restore.sh` on every start) and the marker's age (`now - mtime`) is
  in `[-300, 7200]` seconds (`IDEA_BACKUP_MARKER_MAX_FUTURE_S` default 300,
  `IDEA_BACKUP_MARKER_MAX_AGE_S` default 7200). HTTP 200 with
  `"installed":true,"maintenance":false,"needsDbUpgrade":false` stays the ready path; HTTP 200 or 503 with
  `"maintenance":true` (Nextcloud 31 answers 200) is accepted only with a fresh marker, so a failed postHook, a manual
  `occ maintenance:mode --on`, a leftover older than 2 h, or a mtime more than 5 min in the
  future still goes unhealthy. `hookExclude` lists the marker so it never lands in a hook
  archive. `x-app.healthCheck` is unchanged (updateApp still waits for maintenance off).
- **Images** unchanged since 1.2 (same digests).

**Migration:** none. A leftover dump-dir marker from earlier #29 tips is removed by
`db-clean.sh`; the live marker is in the Nextcloud data dir.

**Tested:** `engine_tested` cba91a6, healthcheck Pi check on idea03 (2026-11-15, app 1.7-31.0.1 at bbd8b0e, throwaway pr30-nc on Disk B): official healthcheck exits 0 for HTTP 200 + `"maintenance":true` with a fresh marker; a hook backup whose dump+borg window exceeded 45 s left `nextcloud-app` healthy; after postHook the marker was gone, the app stayed healthy, and `borg list` of the new archive had no `.idea-backup-pending`; maintenance on with no marker went unhealthy in 36 s; a fresh marker stayed healthy for 60 s, then a 3 h old marker and a +1 h future marker each went unhealthy in 46 s; Engine stop/start cleared a leftover stale marker and the app ended healthy; a stub with `"installed":false` exits 1 and `"installed":true` exits 0.

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

## App store pin (update stages, 2.0 and later)

Decision: Steve, 2026-11-16, on Axle's recommendation (#456 L design input). Applies to every
release that declares `x-app.update` stages (2.0-32.0.15 onwards). Both parts are bundle
scripts; the Engine contract does not change.

- **Why:** on a kit with internet, Nextcloud's app store can move richdocuments past the
  bundled pin during `occ upgrade`, even with prepare. verify would then see a version it did
  not expect and roll the hop back. The pin makes a hop give the same result online and
  offline.
- **Pin (prepare):** after staging the bundled apps, `hooks/prep-custom-apps-for-upgrade.sh`
  runs `hooks/appstore-pin.php`, which sets `appstoreenabled => false` in
  `config/config.php`. It is not `occ config:system:set`, because prepare runs with
  `--no-deps` (no database), as root, on a tree that already needs an upgrade; the script
  writes config.php exactly like Nextcloud's `Config::writeData()` (var_export, in place under
  flock, mode 0640, owner kept). It refuses (prepare fails, the hop rolls back) when the pin
  could not take effect: `appstoreenabled` set in another `config/*.config.php` or via
  `NC_appstoreenabled`, a config.php without `version`, or a non-scalar value.
- **State file:** `./data/nextcloud/custom_apps/.idea-update-state/appstoreenabled.state`
  (container `/var/www/html/custom_apps/.idea-update-state/`, owned by 33). One line
  `previous=unset | bool:true | bool:false | int:<n> | string:<base64>`. It is written
  before config.php changes, so a crash in between leaves the real previous value recorded.
  It lives under `custom_apps` because the image's upgrade rsync deletes unknown top-level
  paths in `/var/www/html`; dot entries are not apps. First record wins: a retried prepare,
  or a later hop's prepare when an earlier settle never finished, keeps the recorded value.
- **Restore (settle):** only when settle is about to exit 0 (settled), as user 33 with the
  database up: `occ config:system:delete appstoreenabled` if it was unset, otherwise
  `occ config:system:set appstoreenabled --value=<v> --type=boolean|integer|string`; then the
  state file is removed. No state file: nothing is touched. "not yet" keeps the pin, so
  background migrations also run without the app store. A failed restore is an `ERROR:`
  (`SETTLE_FAILED`, no rollback); Resume re-runs work and settle, which retries it.
- **Rollback:** a prepare, Start, Health or verify failure restores the Engine snapshot.
  `snapshotExclude: []`, so the snapshot holds `config/config.php` and
  `custom_apps/.idea-update-state/` from before prepare: the old version starts with its own
  `appstoreenabled` and no state file. The Engine runs no stage on rollback and the old
  bundle's hooks are the old release's, so nothing else is needed or possible there. If the
  rollback itself fails, the pre-update Backup Disk backup is from before prepare too. The
  only way the old version could keep the pin is a restore that skips the snapshot; then the
  app store stays off (harmless on an offline-first kit: Office and idea_usage are bundled)
  until the next hop's settle restores the recorded value.
- **Engines that ignore stages** (pre-#463, e.g. 80ba4af): prepare never runs, so nothing is
  pinned and settle has nothing to restore. Engines 41ba677+ refuse stage bundles until #456 L.
- **richdocuments >= rule (verify):** `hooks/verify-update.sh` accepts richdocuments at the
  pinned (bundled) version or newer, by a semver compare (`idea_version_ge` in
  `hooks/update-lib.sh`: numeric core parts, so 9.10.0 > 9.2.3; a pre-release is older than
  its release; anything that is not a version fails). Older, missing or disabled still fails
  (`VERIFY_FAILED`, rollback). A newer version is logged. idea_usage keeps its exact-version
  check.
