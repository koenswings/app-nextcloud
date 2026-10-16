# Nextcloud Demo instance: `demo/install-demo.sh`

```sh
sudo demo/install-demo.sh --disk <diskId> --files /path/to/idea-demo   # first run: installs Nextcloud-Demo
sudo demo/install-demo.sh --files /path/to/idea-demo                   # rerun: reuses it, changes nothing
```

It creates (or reuses) **a separate Engine instance named exactly `Nextcloud-Demo`** and never touches another Nextcloud:

1. Looks up the instance named exactly `Nextcloud-Demo` on this Engine (`demo/engine-cmd.mjs`: the store's command queue,
   the same one the Console and the Engine `client` use). If there is none, it runs
   `installApp nextcloud-latest <disk> --name Nextcloud-Demo`. If there are two or more, it refuses (exit 12).
2. Checks the target: its `compose.yaml` `x-app.instanceName` must be exactly `Nextcloud-Demo`, and its app container
   `<id>-nextcloud-app-1` must belong to compose project `<id>`. It must be on `--disk` if given (exit 13 otherwise).
   If the instance is not Running, it sends `startInstance` through the Engine.
3. Waits for the first-start self-install (`occ status`). The admin is `admin` / `admin911!`.
4. Users: runs this app's own `before-starting/20-idea-accounts.sh` hook in that container with
   `IDEA_NC_SEED_USERS="teacher1:teachers teacher2:teachers learner1:learners learner2:learners learner3:learners"`.
   Every password is `<name>911!`, and existing users and passwords are never changed.
5. Files: uploads `Worksheets/` and `Teacher Notes/` over WebDAV as admin into `IDEA Demo/`. A file whose size
   already matches is skipped. The folder is shared read-only with the `teachers` and `learners` groups (OCS API, once).

Exit codes: 0 ok, 2 usage, 3 Engine unreachable, 11 install, 12 ambiguous name, 13 target check, 14 not ready,
15 users, 16 files. This makes it usable from an Engine hook (idea#235).

The name is `Nextcloud-Demo`, not `Nextcloud Demo`, because the Engine splits `installApp` arguments on whitespace,
so `--name` cannot hold a space (question for Axle).

**Known limit:** the `code` (Collabora) service binds the fixed host port 9980. If another Nextcloud on the same Pi
already runs CODE, the demo's CODE container cannot start. Files, users and sharing still work, but Office editing in
the demo uses the other instance's CODE or none (question for Axle).

Tests: `node --test tests/` (`tests/install-demo.test.mjs`, a stub Engine). On a Pi:
`tests/install-demo-check.sh http://127.0.0.1:<port>` checks the logins and the shared files.
`tests/fingerprint-nextcloud.sh <instance dirs>` fingerprints other instances (read-only) before and after.
