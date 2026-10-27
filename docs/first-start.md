# First start: self-install and hook order

The official `nextcloud` image auto-installs on first start when
`NEXTCLOUD_ADMIN_USER`, `NEXTCLOUD_ADMIN_PASSWORD` and the `MYSQL_*` variables are set
(it retries `maintenance:install` up to 10× while MariaDB comes up). compose.yaml now sets
`admin` / `${IDEA_NC_ADMIN_PASSWORD:-admin911!}` (separate admin secret from the Engine,
koenswings/agent-engine-dev#202; the fallback is the IDEA default `admin911!`) and `NEXTCLOUD_TRUSTED_DOMAINS` (install-time only).

The whole `docker-entrypoint-hooks.d/` folder is mounted read-only. Order on the first start:

1. `maintenance:install`
2. `post-installation/20-idea-bundled-apps.sh` — extract App Disk apps (`bundled-apps/`, richdocuments 8.8.3 for NC 31, sha256-checked) into `custom_apps/` when missing; never overwrites
2b. `post-installation/30-idea-office.sh` — enable richdocuments, point it at CODE (`IDEA_COLLABORA_URL`)
3. `before-starting/10-idea-files.sh` — Files Disk storages (idea#137)
3b. `before-starting/20-idea-bundled-apps.sh` — symlink; lets existing installs pick up the bundle
4. `before-starting/30-idea-office.sh` — symlink to the same Office script; idempotent, re-points the URL when the IP changes

Every later start runs only steps 3–4. All hooks exit 0 (fail open). richdocuments ships on the
App Disk, so Office works fully offline (chosen over baking it into the image: no image rebuild,
and existing installs get it too). Office (CODE) publishes **no host port**: each instance has its own `code`
service on its compose network, and the root entrypoint (`idea-files-entrypoint.sh`,
`IDEA_COLLABORA_PROXY=http://code:9980`) makes Apache proxy `/browser`, `/hosting/*` and the
`/cool` websocket to it. richdocuments gets `wopi_url=http://code:9980` (server side) and
`public_wopi_url=http://${ip}:${port}` (this Nextcloud's own port on the LAN IP the Engine
passes; no Tailscale special case). CODE gets `server_name=${ip}:${port}`, so the editor URL in its discovery is this Nextcloud's
proxy address (richdocuments:activate-config then detects the same public URL). Two Nextclouds
on one Pi therefore never fight over 9980.
An instance installed from an older bundle keeps its own compose (host port 9980) unchanged.

Tests: `node --test tests/` (fake occ + simulated entrypoint hook order).

## Office on a non-LAN address and the CODE welcome dialog (idea#212)

Live check on a claimed pool Pi: `test/live-container.test.sh` runs a throwaway nextcloud+code project on its own port, checks both cases with the real occ and coolwsd, then quarantines its dir.

Two optional keys in the instance `.env`. A school Pi needs neither.

| Key | Default | Effect |
|---|---|---|
| `IDEA_PUBLIC_HOST` | unset (LAN IP `${ip}`) | Address browsers use for this Nextcloud when it isn't the LAN IP, for example a host reached only over Tailscale (wh: its Tailscale IPv4). It's used for `public_wopi_url` and CODE `server_name`, and it's added to `trusted_domains`. The server-side `wopi_url` stays `http://code:9980`. |
| `IDEA_COLLABORA_HOME_MODE` | `false` | `true` hides the CODE 24.04 welcome dialog, but limits CODE to 20 connections and 10 open documents. Use it only on a small demo host, never for a classroom. |

Both keys take effect on the next start of the instance, because the office hook rewrites the URLs on every start.
