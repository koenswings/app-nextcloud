# app-nextcloud

Compose file for the Nextcloud App on IDEA App Disks.

## Default accounts

`admin` / `admin911!`, `teacher1` / `teacher1911!`, `learner1` / `learner1911!` (IDEA `<account name>911!` scheme). See [docs/accounts.md](docs/accounts.md).

## Files Disks

Nextcloud opts in with `x-app.filesMount` (see [docs/files-disk.md](docs/files-disk.md)). A read-only root entrypoint wrapper and a `before-starting` hook on the App Disk reconcile Local external storages with docked Files Disks. Keep `restart: no` on every service.

## Trusted domains

A `before-starting` hook sets `trusted_domains` for the Pi the instance runs on, on every start (from `IDEA_HOSTNAME` / `IDEA_HOST_IPS`, written by the Engine), so a copied or moved instance opens on its new Pi. See [docs/trusted-domains.md](docs/trusted-domains.md). Tests: `node --test tests/`.
