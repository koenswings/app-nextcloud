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
