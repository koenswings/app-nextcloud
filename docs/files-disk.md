# Files Disk support (Nextcloud)

Nextcloud opts in to IDEA Files Disks via `x-app.filesMount` in `compose.yaml`:

```yaml
x-app:
  filesMount:
    path: /mnt/idea-files
    services: [nextcloud-app]
```

The Engine mounts every Files Disk into `nextcloud-app` at `/mnt/idea-files/<slug>-<id6>` and binds a read-only `/mnt/idea-files/.idea-files.json` (display names). Those binds are added by the Engine override — they are **not** listed in this compose file.

## How files appear

Option A (Local external storage), reconciled every container start by:

- `idea-files-entrypoint.sh` — root wrapper (mounted read-only from the App Disk). Chowns each **top-level** `/mnt/idea-files/<x>` directory to uid 33 only when the owner is wrong, then `exec`s `/entrypoint.sh`. Never recursive; never touches `instances/<id>/data`.
- `docker-entrypoint-hooks.d/before-starting/10-idea-files.sh` — enables `files_external`, creates missing Local storages, deletes only storages it marked with option `idea_files=1` whose folder is gone, and sets `filesystem_check_changes=1`. Admin-created storages are never deleted. Deleting a storage removes Nextcloud config only, never files on disk.

Both scripts need **no special case** when Nextcloud runs on a combined App+Files disk.

## Restart policy

Every service keeps `restart: no` so Docker never restarts Nextcloud with a stale Files Disk mount; the Engine decides when to start or recreate.

## Hook behaviour (fix/files-disk-hook)

- **Waits for occ.** On container start MariaDB is often not up yet, so `occ status` fails.
  The hook retries every `IDEA_OCC_INTERVAL` s (3) for up to `IDEA_OCC_WAIT` s (120), then
  skips with "occ not ready after …" and deletes nothing. Not installed → skip at once. Always exits 0.
- **Sharing on.** Own storages get `enable_sharing true` (files_external defaults it to false,
  so teachers could not share files from the Files Disk), plus `idea_files 1` and
  `filesystem_check_changes 1`. Existing own storages are fixed on the next start.
- **Teachers + admin only.** Own storages are limited via `files_external:applicable
  --add-group` to `IDEA_TEACHERS_GROUP` (default `teachers`) and `admin`. The group is
  created with `group:add` if missing (empty; an admin adds teachers to it). Groups an admin
  added to the storage are kept; nothing is removed. An invalid group name is logged and the
  storage is left unrestricted. Admin-created storages are never touched.
- Idempotent: a second start only re-asserts `filesystem_check_changes`.
- Tests: `node --test tests/` (fake occ in `tests/fake-occ-files.mjs`).
