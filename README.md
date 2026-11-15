# app-nextcloud

Compose file for the Nextcloud App on IDEA App Disks.

## Default accounts

`admin` / `admin911!`, `teacher1` / `teacher1911!`, `learner1` / `learner1911!` (IDEA `<account name>911!` scheme). See [docs/accounts.md](docs/accounts.md).

## Files Disks

Nextcloud opts in with `x-app.filesMount` (see [docs/files-disk.md](docs/files-disk.md)). A read-only root entrypoint wrapper and a `before-starting` hook on the App Disk reconcile Local external storages with docked Files Disks. Keep `restart: no` on every service.

## Trusted domains

A `before-starting` hook sets `trusted_domains` for the Pi the instance runs on, on every start (from `IDEA_HOSTNAME` / `IDEA_HOST_IPS`, written by the Engine), so a copied or moved instance opens on its new Pi. See [docs/trusted-domains.md](docs/trusted-domains.md). Tests: `node --test tests/`.

## Demo instance

See [demo/README.md](demo/README.md): the Console "Demo apps" button (Engine `setupDemo`, engine#369) uses the `demo:` block in `app.yaml`, the demo pack (`demo/build-demo-pack.py`) and `demo/hook.sh seed`; `demo/install-demo.sh` installs and seeds a separate "Nextcloud Demo" instance by hand.

## Release check against the previous release (idea#403)

`AAD_CHECK_COMPOSE=<agent-app-dev>/script/check-compose.mjs script/check-base-ref.sh` compares `compose.yaml` with the previous release tag (agent-app-dev `check-compose --base-ref`): a stateful image (MariaDB, MySQL, Postgres, Mongo, Redis) that moves to a new series needs an App major bump. The previous release tag is the highest `<major>.<minor>[-<upstream>]` tag that is an ancestor of HEAD and not HEAD's own tag; a first release is skipped with a note. It needs tags and full history (CI: `fetch-depth: 0`); a shallow clone fails. `node --test tests/release-base-ref.test.mjs` runs it in the release tests (the compare only when `AAD_CHECK_COMPOSE` is set).
