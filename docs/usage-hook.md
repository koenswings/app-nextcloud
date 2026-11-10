# Usage hook (idea#413)

Nextcloud ships `hooks/usage.sh`, mounted at `/hooks/usage.sh` on `nextcloud-app`. The Engine (`agent-engine-dev#308`) invokes it as `pi` with:

```
docker compose exec -T nextcloud-app /hooks/usage.sh day YYYY-MM-DD
docker compose exec -T nextcloud-app /hooks/usage.sh sample
```

Unlisted containers borrow the same file via `sh -s`. The script uses Python on the test box and PHP inside the official Nextcloud image (which has no Python). Both paths are read-only (`PRAGMA query_only` / `SET SESSION TRANSACTION READ ONLY`).

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

Role keys are singular everywhere they name a role: `office.byGroup` and `logins` use `admin`, `teacher`, `learner`. Census counts on `setup` stay `admin` / `teachers` / `learners` (how many accounts), plus `otherGroups`.

Workflows: `worksheetShares`, `editShares`, `fileDropLinks`, `fileDropUploads`, `schoolFilesShares`. Worksheet shares skip the School Files storage (`local::/mnt/idea-files`).

## Sample document ids

Each sample’s `office.documentIds` is an opaque list of HMAC-SHA256 digests (16 hex chars) of the WOPI `fileId`, salted per instance. The Engine unions those lists to compute `distinctDocuments`. The salt is `IDEA_USAGE_INSTANCE_SALT` or Nextcloud’s `instanceid` from `config.php`. File names, paths and raw file ids never appear in stdout.

`office` on a day file may be incomplete (WOPI rows expire). When samples exist, the Engine reduces them into the stored `office` object.

Run `python3 -m unittest tests.test_usage_hook` (no Docker).
