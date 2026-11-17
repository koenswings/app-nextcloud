# x-app.update stages (engine#456, DRAFT)

Status: **draft**, written against the contract in the
[engine#456](https://github.com/koenswings/agent-engine-dev/issues/456) issue body (Axle addendum
2026-11-15, idea#548) and Axle's #456 design comment (2026-11-17; Steve's decisions in its §8). It
waits for the Engine runner code. Engine
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

Engine env (design §8 Q7, Axle's answer): `IDEA_UPDATE_FROM` / `IDEA_UPDATE_TO` are the old and new
`x-app.version` (for example `1.8-31.0.14` → `2.0-32.0.15`), passed with `-e` on both `compose run`
(prepare) and `compose exec` (verify / work / settle). Every step logs them as `hop A -> B`; no step
depends on them. The Engine adds no other env; `run` and `exec` also see the compose env
(`IDEA_APP_VERSION`).

Output lines: the Engine matches `ERROR:` and `not yet:` only at the **start** of a line (after
leading whitespace) and keeps the last one (≤ 200 characters). So every error / pending line starts
with `ERROR:` / `not yet:` and names the script at the end: `ERROR: status.php unreachable
[idea-verify-update]`. Info lines are `<script>: …`.

TERM safety: on a step timeout the Engine sends SIGTERM to the in-container pid, then SIGKILL after
10 s. Every step script traps TERM / INT / HUP: it stops its running child (occ, `cron.php`, `tar`,
started in the background and waited on so the trap fires at once), removes its own temp files,
prints `ERROR: interrupted by SIGTERM [<script>]` and exits 143. Temp files are made only in the main
shell (never inside `$(...)`, where traps are reset). Writes are atomic:

- `appstore-pin.php` writes the state file and `config.php` each to a temp file in the same
  directory (`<state>.tmp-<pid>`, `config/.config.php.idea-tmp-<pid>`), fsyncs, copies mode / owner /
  group, then renames. The state file is written first. A kill leaves the old or the new file, never
  a partial one; a rerun removes stale temp files first. A read-only `config.php` is still refused.
- prepare only renames (`mv` within `custom_apps`) and extracts into a dot-named staging dir. A rerun
  removes stale plan / info files, moves any leftover `.idea-prep-staging-*` into
  `.idea-upgrade-backup/<name>-interrupted-<ts>` (never `rm -rf`), re-extracts an app whose old tree was
  already moved aside, and chowns a tree that is already in place. Kill points are covered by
  `tests/term-safety.test.mjs` (`IDEA_PREP_TEST_KILL_AT`, `IDEA_PIN_TEST_DIE_AT`, tests only).
- work: the app store restore is occ (Nextcloud's own config write) and removes the state file only
  after occ succeeded, so a rerun restores again; the schema repairs and `cron.php` are idempotent.
- verify and settle write nothing but their own temp file.

The Engine still restores the snapshot after any failed or interrupted prepare or verify; the App's
resumability is defensive.

## Test switch: injected verify failure (Pi proofs only)

For the Engine runner's injected-failure run (engine#456 / PR #505: expect `VERIFY_FAILED`, then a
rollback), verify fails on purpose while this file exists:

| In the container | On the host |
|---|---|
| `/var/www/html/data/.idea-test-fail-verify` | `<instance dir>/data/nextcloud/data/.idea-test-fail-verify` |

It is checked first, before status.php and occ, and prints, as its last line:

    ERROR: verify failed (test switch /var/www/html/data/.idea-test-fail-verify) [idea-verify-update]

then exits 1. It is a file, not env, because the Engine passes only `IDEA_UPDATE_FROM` / `IDEA_UPDATE_TO`
and the data dir persists through Swap without editing compose (the Nextcloud data dir is not served over
HTTP). Create it on the old (1.x) instance before `updateApp`, e.g.
`sudo touch <instance dir>/data/nextcloud/data/.idea-test-fail-verify`. The file is in the pre-update
snapshot, so it is still there after the rollback: remove it before the next run. Never ship it: no
release step creates it. `IDEA_TEST_FAIL_VERIFY_MARKER` overrides the path for unit tests only.

Env knobs (tests and emergencies only): `IDEA_WORK_SCHEMA_REPAIR=0`, `IDEA_WORK_REPAIR_EXPENSIVE=0`,
`IDEA_WORK_CRON_RUNS`, `IDEA_NC_HEALTH_URL`, `IDEA_BUNDLED_APPS`, `IDEA_CUSTOM_APPS`.

Tests: `node --test tests/` (`x-app-update`, `prep-custom-apps-for-upgrade`, `appstore-pin`,
`verify-update`, `work-update`, `settle-update`, `version-compare`, `term-safety`). Set `AAD_CHECK_COMPOSE` to
agent-app-dev `script/check-compose.mjs` to also run its gap-12 `x-app.update` rules.
