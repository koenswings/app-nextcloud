# app-nextcloud

Compose file for the Nextcloud App on IDEA App Disks.

## Files Disks

Nextcloud opts in with `x-app.filesMount` (see [docs/files-disk.md](docs/files-disk.md)). A read-only root entrypoint wrapper and a `before-starting` hook on the App Disk reconcile Local external storages with docked Files Disks. Keep `restart: no` on every service.
