# x-app.update stages (engine#456, DRAFT)

Status: **draft**, written against the contract in the
[engine#456](https://github.com/koenswings/agent-engine-dev/issues/456) issue body (Axle addendum
2026-11-15, idea#548). It waits for Axle's #456 design comment and the Engine runner. Engine
41ba677+ (engine#463 interim) refuses a bundle that declares these stages with
`UPDATE_STAGES_UNSUPPORTED`, so do not release this block on 1.x before the runner lands.

The same scripts and the same `x-app.update` block ship on every release branch
(1.x here, 2.0-32.0.15 … 6.0-35.0.3 on `kid/nc-2.0` … `kid/nc-5.0`). Versions come from the bundled
tarballs, with a fallback to `hooks/update-targets` keyed by `IDEA_APP_VERSION`.

Order after Swap: **prepare** → Start (image entrypoint: `occ upgrade`, then the before-starting
hooks) → Health → **verify** → **work** → **settle**.

| Stage | Runs as | Script | What it does | Idempotent | Timeout | Failure |
|---|---|---|---|---|---|---|
| prepare | one-off `compose run --rm --no-deps --no-TTY --user 0 nextcloud-app`, override `entrypoint: [command]`, empty command; no DB | `/idea/hooks/prep-custom-apps-for-upgrade.sh` | sha256 of every `bundled-apps/*.tar.gz` against `SHA256SUMS`; for each app whose `custom_apps/<app>` is not the tarball's `<version>` + `max-version`, `mv` it into `custom_apps/.idea-upgrade-backup/<app>-<old>-<ts>/` and extract the bundled tree (chown 33). Then pins `appstoreenabled=false` in `config.php` (`hooks/appstore-pin.php`), previous value in `custom_apps/.idea-update-state/appstoreenabled.state`. No occ. | yes (second run: "already at … skip") | 600 s | non-zero → `PREPARE_FAILED`, roll back |
| verify | `exec -T -u 33` | `/idea/hooks/verify-update.sh` | `status.php` HTTP 200, `installed:true`, `maintenance:false`, `needsDbUpgrade:false`; `occ app:list` Enabled has richdocuments at the pinned version or newer (semver) and `idea_usage` at its exact version | yes (read-only) | 120 s | non-zero → `VERIFY_FAILED`, roll back |
| work | `exec -T -u 33` | `/idea/hooks/work-update.sh` | restore `appstoreenabled` from the state file (occ), then `occ db:add-missing-indices`, `db:add-missing-columns`, `db:add-missing-primary-keys`, `maintenance:repair --include-expensive`, then `cron.php` up to 3 times until no upgrade background jobs | yes | 3600 s | exit 1 (`ERROR:`) or 3 (`not yet:`) or timeout → `migrationsPending`, no rollback; Resume re-runs work |
| settle | `exec -T -u 33`, polled every 60 s | `/idea/hooks/settle-update.sh` | read-only: `status.php` installed / maintenance false / needsDbUpgrade false, and no pending `Migration|BackgroundRepair|RepairJob` jobs (`occ background-job:list`) | yes (no writes) | 3600 s | 0 settled, 3 not yet (poll), other → `SETTLE_FAILED` / `migrationsPending`, no rollback |

App store pin: prepare sets `appstoreenabled=false` before `occ upgrade`, so an online Pi never pulls a
newer richdocuments (or anything else) from the app store during the upgrade; work restores the
previous value first thing. verify accepts richdocuments at the pinned version or newer.

Not stages: `occ upgrade` and maintenance mode on/off are done by the official image entrypoint at
Start (it refuses to skip a Nextcloud major). App re-enable after Start is the before-starting hooks
(`25-idea-usage.sh`, `30-idea-office.sh`, fail open); verify is the fail-closed net. MariaDB system
tables: `MARIADB_AUTO_UPGRADE=1` on the db entrypoint.

Env knobs (tests and emergencies only): `IDEA_WORK_SCHEMA_REPAIR=0`, `IDEA_WORK_REPAIR_EXPENSIVE=0`,
`IDEA_WORK_CRON_RUNS`, `IDEA_NC_HEALTH_URL`, `IDEA_BUNDLED_APPS`, `IDEA_CUSTOM_APPS`.

Tests: `node --test tests/` (`x-app-update`, `prep-custom-apps-for-upgrade`, `appstore-pin`,
`verify-update`, `work-update`, `settle-update`, `version-compare`). Set `AAD_CHECK_COMPOSE` to
agent-app-dev `script/check-compose.mjs` to also run its gap-12 `x-app.update` rules.
