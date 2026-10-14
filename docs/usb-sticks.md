# USB sticks in Nextcloud (idea#193)

Proposal: `koenswings/idea` `proposals/2026-10-14-teacher-usb-sticks.md` §4.

- `compose.yaml` opts in with `x-app.usbMount: { path: /mnt/idea-usb, services: [nextcloud-app] }`.
  The Engine binds host `/run/idea-usb` → `/mnt/idea-usb` **read-only, `bind.propagation: rslave`**,
  so sticks mounted later appear in the running container (no recreate).
- `usb-sync.sh` is mounted at `/idea/usb-sync.sh`. The Engine runs
  `timeout 120 docker exec -u www-data -e IDEA_USB_EVENT=plug|unplug|start -e IDEA_USB_ROOT -e IDEA_USB_JSON <id>-nextcloud-app-1 /idea/usb-sync.sh` (one retry after 15 s) at start and after every plug/unplug (Engine contract: agent-engine-dev docs/USB-STICKS.md).
  A valid `{version:1, sticks:[...]}` JSON is the complete list: a device missing from it is gone even while its folder is still mounted (unplug syncs before umount). Missing/invalid JSON → folder-existence rule; nothing is deleted because the JSON couldn't be read. Nextcloud not ready → exit 0 (occ wait ≤75 s, so the run stays under 120 s).
- Per folder `/mnt/idea-usb/<dev>` it creates a Local storage `USB: <label>` with
  `readonly=true`, `filesystem_check_changes=1`, `enable_sharing=false`, marker `idea_usb=1`,
  applicable to `$IDEA_TEACHERS_GROUP` (default `teachers`, created if missing) + `admin`.
  Invalid group name → admin only.
- Names come from the Engine's `/mnt/idea-usb/.idea-usb.json`. Accepted: an array (or `{sticks: [...]}`)
  of `UsbStickPublic`-like objects matched on `device` (uses `displayName`, else `label`), or a map
  `{ "<dev>": "USB: X" | {displayName} }`. "USB: " is prefixed when missing; `/` becomes `-`. No entry → `USB: <dev>`.
- Removes only `idea_usb=1` storages whose folder is gone, or whose name no longer matches (another stick on
  the same device). Config only, never files. Admin-created storages are never changed or deleted, and a
  stick folder that already has an admin storage gets no second one.
- Idempotent; runs serialised by a lock dir (`/tmp/idea-usb-sync.lock`); waits for occ (bounded, `IDEA_OCC_WAIT`);
  fail-open (always exit 0; nothing deleted if occ is unusable; `/mnt/idea-usb` absent → skip).

Tests: `node --test tests/` (`tests/usb-sync.test.mjs`, fake occ).
