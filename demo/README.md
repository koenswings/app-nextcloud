# Nextcloud Demo instance (demo/install-demo.sh)

The demo is always its **own** Nextcloud instance whose display name is exactly
`Nextcloud Demo` (technical id e.g. `nextcloud-demo`), installed alongside any real
Nextcloud. It never seeds into an existing Nextcloud. The IDEA Engine is driven only
through the store command queue, like the Console: push the command onto
`engineDB[<engine>].commands`, follow the command-log trace to Done/Failed
(`demo/engine-cmd.mjs`). No docker compose.

```sh
demo/install-demo.sh --engine-dir ~/idea/agent-engine-dev --content /path/to/idea-demo [--disk <diskId>]
```

1. Find the instance named exactly `Nextcloud Demo` (two: refuse, exit 10). `--instance <id>` is refused
   unless it is that instance (exit 11).
2. None: `installApp nextcloud-1.0 <disk> --name "Nextcloud Demo"`, no `--source` (clean builder bundle,
   never a school's data). If the Engine did not keep the name, stop (exit 13).
3. `startInstance` if it is not Running.
4. Guard: `occ user:list` may only contain the demo accounts, otherwise refuse with nothing changed (exit 6).
5. Groups `teachers`/`learners`; users `admin`, `teacher1`, `teacher2` (teachers), `learner1..3` (learners)
   with password `<name>911!` (`occ user:add --password-from-env`). Existing users keep their password
   unless `--force-passwords`.
6. WebDAV upload of `Worksheets/` and `Teacher Notes/` into `teacher1` and `teacher2`. A rerun overwrites
   the same paths: no duplicates, no second instance.

Exit codes: 0 ok, 2 usage, 3 Engine unreachable, 6 non-demo users present, 10 two demo instances,
11 target refused, 12 installApp Failed, 13 no instance with the demo name, 15 occ failed, 16 WebDAV failed,
17 startInstance Failed, 18 no/ambiguous disk. Last stdout line is JSON. Sourcing the script defines the
functions without running it (Engine hook / Console demo button, idea#235).

**Depends on the Engine fix (Axle, pending):** quote-aware `installApp --name "Nextcloud Demo"` and the
instance name in the store record. Until then the script fails closed (exit 13).

Tests: `node --test tests/` (`tests/install-demo.test.mjs` mocks the Engine queue, occ and WebDAV).
