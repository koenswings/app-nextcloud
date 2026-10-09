# trusted_domains on every start (agent-engine-dev#163)

`trusted_domains` is stored in `data/nextcloud/config/config.php`, on the App Disk. After a copy or move to another Pi it still names the old host, and Nextcloud answers 400 "Access through untrusted domain". The image's `NEXTCLOUD_TRUSTED_DOMAINS` only applies at first install.

`docker-entrypoint-hooks.d/before-starting/20-idea-trusted-domains.sh` (mounted read-only and run by the image on every start, as www-data) sets the list from two env vars. The Engine writes them into the instance `.env` on every start, and `compose.yaml` passes them through:

| Env | Value |
|-----|-------|
| `IDEA_HOSTNAME` | bare hostname of the Pi (`idea03`); the hook also adds `idea03.local` |
| `IDEA_HOST_IPS` | comma-separated IPv4 addresses of the Pi (LAN, Wi-Fi, Tailscale), no ports |

Rules:
- **Order:** `localhost`, the host, `host.local`, then every IPv4. Non-IPv4 values are ignored and logged.
- **Own entries:** the hook records what it wrote in the system key `idea_trusted_domains_managed` and replaces only those. Any other entry (an admin's, or the install-time host) is kept after its own. `localhost` is always kept.
- **Idempotent:** nothing is written when the config already matches.
- **Fail open:** with both vars empty (an older Engine), when occ is not ready, or when a set fails, the config is left as it is and the hook exits 0, so Nextcloud still starts.
- **Never empty:** entries are set by index, then only the stale tail is deleted.

Tests: `node --test tests/` (fake occ in `tests/fake-occ.mjs`).
