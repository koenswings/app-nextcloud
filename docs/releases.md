# Releases

Tags are set by the Lead bot on the merged release commit (`<IDEA major>.<minor>-<Nextcloud version>`).
Kits get a release only through Engine `updateApp` (idea#374). Every release so far keeps the
same pinned images, so no image is rebuilt or republished.

## 1.5-31.0.1

Since the last tag, `1.2-31.0.1` (0a6e764). 1.3 and 1.4 were version bumps on main and were never tagged.

- **Usage hook** (idea#413, 1.3): `x-app.usage` → `/hooks/usage.sh` day summaries for the
  usage dashboard: setup and logins per group, Office opens, shares and File drop.
- **Shares and File drop by group** (idea#431, 1.4).
- **Apps opened and documents created** (idea#464, 1.5): the bundled `idea_usage` 1.0.0 app
  (`bundled-apps/`, enabled by `25-idea-usage.sh`) counts full-page app opens per day, group
  and app in `oc_idea_usage_apps_opened`. The hook adds `appsOpened`, `appsOpenedByGroup`
  and `documents{created, byGroup}` (omitted when the activity app is off).
- **Empty skeleton** (idea#464, #22 and #23): `config/idea-skeleton.config.php` sets
  `skeletondirectory` and `templatedirectory` to empty, and `05-idea-skeleton-config.sh`
  copies it into Nextcloud's `config/` **before `maintenance:install`** (and on every later
  start). No account gets example files, including the install-time `admin`, so a fresh
  install starts at `documents.created` 0 and the count covers only real work.
  `26-idea-skeleton.sh` stays as an `occ` fallback. Existing users' files are never touched.
- **Images by digest** (idea#322): `koenswings/nextcloud:1.0-31.0.1`,
  `koenswings/nextcloud-mariadb:1.0-11.7.2-MariaDB-ubu2404`, `koenswings/nextcloud-code:1.0-24.04.13.2`,
  all linux/arm64, unchanged since 1.2.

**Migration:** none beyond Nextcloud's own first start. Nextcloud stays on 31.0.1, so there is
no database upgrade. On the first start of 1.5 the before-starting hooks enable `idea_usage`
(its migration creates the counter table) and put the empty-skeleton config file in place
(the new `./config:/idea-config:ro` bind). Files and accounts are kept.

**Tested:** `engine_tested` 431ab4c, 7-step on-Pi check (steps 1–6 on idea04, step 7 on idea03; app 1.5-31.0.1 at af5f289). Earlier checks on idea03 at c460aca, 1224f54 and 3fa97b1 (app-nextcloud#22, #23).
