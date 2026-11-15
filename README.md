# app-nextcloud

Compose file for the Nextcloud App on IDEA App Disks.

## Default accounts

`admin` / `admin911!`, `teacher1` / `teacher1911!`, `learner1` / `learner1911!` (IDEA `<account name>911!` scheme). See [docs/accounts.md](docs/accounts.md).

## Files Disks

Nextcloud opts in with `x-app.filesMount` (see [docs/files-disk.md](docs/files-disk.md)). A read-only root entrypoint wrapper and a `before-starting` hook on the App Disk reconcile Local external storages with docked Files Disks. Keep `restart: no` on every service.

## Trusted domains

A `before-starting` hook sets `trusted_domains` for the Pi the instance runs on, on every start (from `IDEA_HOSTNAME` / `IDEA_HOST_IPS`, written by the Engine), so a copied or moved instance opens on its new Pi. See [docs/trusted-domains.md](docs/trusted-domains.md). Tests: `node --test tests/`.

## Backup

Live backup with `x-app.backup` method `hook` (idea#403): maintenance mode and a MariaDB dump while the instance runs; a restored hook archive imports the dump on first start. The app healthcheck stays healthy during that maintenance window only while the backup marker exists and is no older than 2 hours (app-nextcloud#29). See [docs/backup.md](docs/backup.md).

## Demo instance

See [demo/README.md](demo/README.md): the Console "Demo apps" button (Engine `setupDemo`, engine#369) uses the `demo:` block in `app.yaml`, the demo pack (`demo/build-demo-pack.py`) and `demo/hook.sh seed`; `demo/install-demo.sh` installs and seeds a separate "Nextcloud Demo" instance by hand.

## Release check against the previous release (idea#403)

- **Before tagging a release, run `script/check-base-ref.sh` in a full clone with tags, with `AAD_CHECK_COMPOSE` set:** `AAD_CHECK_COMPOSE=<agent-app-dev>/script/check-compose.mjs script/check-base-ref.sh`.
- It compares `compose.yaml` with the previous release tag (agent-app-dev `check-compose --base-ref`). A stateful image (MariaDB, MySQL, Postgres, Mongo, Redis) that moves to a new series needs an App major bump.
- **Previous release tag:** the highest `<major>.<minor>[-<upstream>]` tag that is an ancestor of HEAD and is not HEAD's own tag.
- **It fails** in a shallow clone (`git fetch --unshallow --tags`; CI: `fetch-depth: 0`) and in a clone with no release tags at all (`git fetch --tags`).
- **First release:** if the repo has release tags but none of them is an ancestor, it is skipped with a note. If there are no release tags at all, a real first release must set `CHECK_BASE_REF_FIRST_RELEASE=1`.
- `node --test tests/release-base-ref.test.mjs` tests it. The compare runs only when `AAD_CHECK_COMPOSE` is set.
