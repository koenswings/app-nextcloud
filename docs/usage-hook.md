# Usage hook (idea#413, idea#431, idea#464)

Nextcloud ships `hooks/usage.sh`, mounted at `/hooks/usage.sh` on `nextcloud-app`. The Engine (`agent-engine-dev#308`) invokes it as `pi` with:

```
docker compose exec -T nextcloud-app /hooks/usage.sh day YYYY-MM-DD
docker compose exec -T nextcloud-app /hooks/usage.sh sample
```

Unlisted containers borrow the same file via `sh -s`. The script uses PHP inside the official Nextcloud image (detected by `/var/www/html/occ`, since the image also ships python3) and Python on the test box. Both paths are read-only (`PRAGMA query_only` / `SET SESSION TRANSACTION READ ONLY`).

## Declaration

```yaml
x-app:
  usage:
    service: nextcloud-app
    command: /hooks/usage.sh
    timeoutS: 30
```

## Output

Stdout is exactly one JSON object.

| Mode | Schema | Notes |
|------|--------|--------|
| `day YYYY-MM-DD` | `idea-usage-day/1` | `setup`, `logins`, `office`, `workflows`, and when available `appsOpened` / `appsOpenedByGroup` and `documents`. |
| `sample` | `idea-usage-sample/1` | Current WOPI token snapshot. |

The hook never prints `engine`, `instance`, `name`, `listed`, `clock`, `collectedAt`, `hookStatus` or `skipReason`.

Role keys are singular everywhere they name a role: `setup`, `logins`, `office.byGroup` and `workflows.byGroup` use `admin`, `teacher`, `learner`. `setup` and `logins` each emit `{total, beyondSeed}` per role (plus `otherGroups` on `setup`). `office.byGroup` stays a count of tokens, not a RoleCount. Seeds are matched by username inside the hook only (first-start `IDEA_NC_SEED_USERS` / `NEXTCLOUD_ADMIN_USER`, plus the demo fixture names `teacher2`, `learner2`, `learner3`) and never written to stdout.

Workflows keep the flat totals `worksheetShares`, `editShares`, `fileDropLinks`, `fileDropUploads`, `schoolFilesShares`. Worksheet shares skip the School Files storage (`local::/mnt/idea-files`). idea#431 adds an additive `workflows.byGroup` object with the same role keys for `worksheetShares`, `editShares`, `fileDropUploads` and `schoolFilesShares` (not `fileDropLinks`). Each map is plain counts, like `office.byGroup`, not `{total, beyondSeed}`.

Shares are attributed with `oc_share.uid_initiator` if set, otherwise `uid_owner`, then the same Nextcloud-group mapping as Office opens (`admin` wins, then `teachers` → `teacher`, otherwise `learner`).

File-drop uploads are anonymous public-link posts: `oc_filecache` has no uploader uid. The hook attributes each upload to the **link owner** (the same initiator-or-owner of the `share_type = 3` create-only share whose folder is the file's parent). That is the only identified actor, and it answers U-7 line 5 (“an action by a teacher or learner”): uploads into a teacher- or learner-owned drop folder count; uploads into an admin-owned drop folder do not. Ambiguity: the wording could also mean the person who posted the file. We cannot see that person, and treating a missing uid as `learner` would hide admin-owned drops as learner activity, so we do not do that.


## Apps opened (idea#464)

A small bundled Nextcloud app, `idea_usage`, is extracted from `bundled-apps/` like richdocuments and enabled by `25-idea-usage.sh` on first start and every later start. It listens for logged-in full-page renders (`OCP\AppFramework\Http\Events\BeforeTemplateRenderedEvent`) and stores counts only: `(UTC day, group, appId) → n` in `oc_idea_usage_apps_opened`. Group mapping is the same as Office opens and shares: admin wins, then `teachers` → teacher, otherwise learner. No user ids, paths or file names are stored.

On `day YYYY-MM-DD` the hook emits:

- `appsOpened`: `{<appId>: n}` summed across groups for that day. `{}` means the counter is installed and nothing was opened.
- `appsOpenedByGroup`: `{<appId>: {admin, teacher, learner}}` (additive).

Both fields are **omitted** when the counter table is missing, so the collector keeps `appsOpened` as null (UI "No data").

This is a dedicated IDEA counter, not the web access log.

## Documents created (idea#464)

When the Nextcloud **activity** app is enabled, `day YYYY-MM-DD` also emits `documents: {created: n, byGroup: {admin, teacher, learner}}`. That is the office-document count for the day (text / sheet / slides, the same `mime_kind` split as `office.mime`).

Source: `oc_activity` rows with `app='files'`, `type='file_created'` and `subject='created_self'`, deduplicated by `object_id`, joined to `oc_filecache.mimetype`. The actor is the activity `user` column, mapped to a group the same way as Office opens. Anonymous File drop uploads (`created_public`) are left out. Queries are read-only.

If the activity app is disabled, or the `oc_activity` table is missing, the hook **omits** `documents` (collector: null, UI "No data"). It does not emit `0`, which would look like a measured day with no documents. The issue also sketched a fallback from `oc_filecache_extended.upload_time`; that is left for a follow-up once the collector can mark a count as approximate (see the PR).

Stock Nextcloud 31 copies `core/skeleton` (about 17 example files) and the shipped templates into a new user's home on first login. Those `created_self` office documents inflate `documents.created`. `config/idea-skeleton.config.php` sets `skeletondirectory` and `templatedirectory` to empty; `05-idea-skeleton-config.sh` copies it into Nextcloud's `config/` before `maintenance:install` (so the install-time `admin` gets no files either) and on every later start. `26-idea-skeleton.sh` stays as an `occ` fallback. A new user's first login, including the first admin's, creates no files, so `documents.created` starts at 0 on a fresh install. Existing users' already-copied files are not changed.

A later Pi check should confirm that activity is enabled by default, that Files "New document" writes `file_created` / `created_self`, and that the counter listener fires for Files, Office, Text and Photos page opens.

## Sample document ids

Each sample’s `office.documentIds` is an opaque list of HMAC-SHA256 digests (16 hex chars) of the WOPI `fileId`, salted per instance. The Engine unions those lists to compute `distinctDocuments`. The salt is `IDEA_USAGE_INSTANCE_SALT` or Nextcloud’s `instanceid` from `config.php`. File names, paths and raw file ids never appear in stdout.

`office` on a day file may be incomplete (WOPI rows expire). When samples exist, the Engine reduces them into the stored `office` object.

Run `python3 -m unittest tests.test_usage_hook` (no Docker).
