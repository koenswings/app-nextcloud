# Usage hook (idea#413, idea#431)

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
| `day YYYY-MM-DD` | `idea-usage-day/1` | `setup`, `logins`, `office`, `workflows`. `appsOpened` is omitted until Phase 3. |
| `sample` | `idea-usage-sample/1` | Current WOPI token snapshot. |

The hook never prints `engine`, `instance`, `name`, `listed`, `clock`, `collectedAt`, `hookStatus` or `skipReason`.

Role keys are singular everywhere they name a role: `setup`, `logins`, `office.byGroup` and `workflows.byGroup` use `admin`, `teacher`, `learner`. `setup` and `logins` each emit `{total, beyondSeed}` per role (plus `otherGroups` on `setup`). `office.byGroup` stays a count of tokens, not a RoleCount. Seeds are matched by username inside the hook only (first-start `IDEA_NC_SEED_USERS` / `NEXTCLOUD_ADMIN_USER`, plus the demo fixture names `teacher2`, `learner2`, `learner3`) and never written to stdout.

Workflows keep the flat totals `worksheetShares`, `editShares`, `fileDropLinks`, `fileDropUploads`, `schoolFilesShares`. Worksheet shares skip the School Files storage (`local::/mnt/idea-files`). idea#431 adds an additive `workflows.byGroup` object with the same role keys for `worksheetShares`, `editShares`, `fileDropUploads` and `schoolFilesShares` (not `fileDropLinks`). Each map is plain counts, like `office.byGroup`, not `{total, beyondSeed}`.

Shares are attributed with `oc_share.uid_initiator` if set, otherwise `uid_owner`, then the same Nextcloud-group mapping as Office opens (`admin` wins, then `teachers` → `teacher`, otherwise `learner`).

File-drop uploads are anonymous public-link posts: `oc_filecache` has no uploader uid. The hook attributes each upload to the **link owner** (the same initiator-or-owner of the `share_type = 3` create-only share whose folder is the file's parent). That is the only identified actor, and it answers U-7 line 5 (“an action by a teacher or learner”): uploads into a teacher- or learner-owned drop folder count; uploads into an admin-owned drop folder do not. Ambiguity: the wording could also mean the person who posted the file. We cannot see that person, and treating a missing uid as `learner` would hide admin-owned drops as learner activity, so we do not do that.

## Sample document ids

Each sample’s `office.documentIds` is an opaque list of HMAC-SHA256 digests (16 hex chars) of the WOPI `fileId`, salted per instance. The Engine unions those lists to compute `distinctDocuments`. The salt is `IDEA_USAGE_INSTANCE_SALT` or Nextcloud’s `instanceid` from `config.php`. File names, paths and raw file ids never appear in stdout.

`office` on a day file may be incomplete (WOPI rows expire). When samples exist, the Engine reduces them into the stored `office` object.

Run `python3 -m unittest tests.test_usage_hook` (no Docker).
