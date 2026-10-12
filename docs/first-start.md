# First start: self-install and hook order

The official `nextcloud` image auto-installs on first start when
`NEXTCLOUD_ADMIN_USER`, `NEXTCLOUD_ADMIN_PASSWORD` and the `MYSQL_*` variables are set
(it retries `maintenance:install` up to 10× while MariaDB comes up). compose.yaml now sets
`admin` / `${pass}` and `NEXTCLOUD_TRUSTED_DOMAINS` (install-time only).

The whole `docker-entrypoint-hooks.d/` folder is mounted read-only. Order on the first start:

1. `maintenance:install`
2. `post-installation/30-idea-office.sh` — enable richdocuments, point it at CODE (`IDEA_COLLABORA_URL`)
3. `before-starting/10-idea-files.sh` — Files Disk storages (idea#137)
4. `before-starting/30-idea-office.sh` — symlink to the same Office script; idempotent, re-points the URL when the IP changes

Every later start runs only step 3–4. All hooks exit 0 (fail open). Offline Pis can't download
richdocuments: if the app code isn't present the Office hook warns and Nextcloud starts without Office.

Tests: `node --test tests/` (fake occ + simulated entrypoint hook order).
