# Nextcloud Demo

Two ways to get a "Nextcloud Demo" instance:

1. **Console "Demo apps" / Engine `setupDemo`** (agent-engine-dev#369): the Engine installs the
   instance, fetches and checks the demo pack, starts it and runs `demo/hook.sh seed`. Below.
2. **By hand**: `demo/install-demo.sh` (older flow through the Engine queue), further down.

## Demo pack and Engine hook (engine#369)

`app.yaml` has a `demo:` block: name `Nextcloud Demo`, `minEngine: "1.0"`, the pack pin
(`file`, full release `url`, `sha256`, `bytes`, `minVersion`), `reserveBytes`, and one step:

```yaml
steps:
  - { id: seed, run: demo/hook.sh seed, needs: running, timeoutSec: 1200 }
```

The Engine looks for a local pack first (`IDEA-DEMO/idea-demo-nextcloud-v1.tar` or
`IDEA-DEMO/nextcloud/pack.json` on a docked disk or USB stick), otherwise downloads the
pinned release asset, checks the sha256, extracts it to `<instance>/demo-pack/x`, starts the
instance and then runs the hook with `IDEA_DEMO_PACK_DIR`, `IDEA_DEMO_PORT`,
`IDEA_DEMO_COMPOSE_PROJECT` (and `IDEA_DEMO_DATA_DIR` = `<instance>/data`).

**Pack** (`demo/build-demo-pack.py`, deterministic tar, no wrapping folder):

| Pack path | Goes to | Shared with |
|---|---|---|
| `Class/` | teacher1 `/Grade 5A/` | group `grade5a` ("Grade 5A"), view only; `teachers`, edit |
| `Worksheets/` | teacher1 `/Grade 5A/Worksheets/` | (inside Grade 5A) |
| `Teacher Notes/` | teacher1 `/Teacher Notes/` | `teachers`, edit |
| `Learner Files/` | each learner's `/My work/` | nobody |

plus `pack.json` (schemaVersion 1, `hooks: [{id: seed, needs: running}]`, every file's sha256)
and `CREDITS.txt` (one catalogue line per file with its licence; the build fails otherwise).
Pack paths must pass the Engine's `SAFE_REL` rule (letters, digits, `. _ - /` and spaces).

**Accounts** (school rule `<account>911!`): `admin` (first-start install, only checked),
`teacher1`, `teacher2` (`teachers`), `learner1..3` (`learners` + `grade5a`).

**Hook rules**: `demo/hook.sh seed` only seeds. It never calls the Engine queue, `installApp`,
`startInstance`, `stopInstance` or `docker compose`, and never writes under `/tmp`.
`demo/seed_nextcloud.py` waits until Nextcloud is installed, runs occ only with
`docker exec -u 33` in the `nextcloud-app` container of `IDEA_DEMO_COMPOSE_PROJECT`, and does
files and shares over WebDAV/OCS on `127.0.0.1:$IDEA_DEMO_PORT` as the owner. It is idempotent:
a re-press adds what is missing, puts changed demo files back (same path, no copies), keeps
extra files, never makes a second share, and keeps changed passwords (that account is skipped
with a warning; `IDEA_DEMO_RESET_PASSWORDS=1` resets them).

**Rebuild and re-pin** after changing `demo/content/` or `demo/CREDITS.txt`:

```sh
demo/build-demo-pack.py --out <dir> --repo-pack demo --pin app.yaml
```

`tests/demo-pack.test.mjs` fails when the `app.yaml` pin or `demo/pack.json` is stale.
Publishing the release asset (`idea-demo-nextcloud-v1` tag) is a separate, approved step.

Tests: `node --test tests/*.test.mjs` (`tests/demo-pack.test.mjs`, `tests/demo-hook.test.mjs`
with a fake Nextcloud, fake docker and fake occ).

## By hand: demo/install-demo.sh

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
2. None: `installApp <app> <disk> --source <source disk> --name "Nextcloud Demo" --fresh` (`--source`
   defaults to the target disk; `--fresh` = the whole app bundle, never a school's data; no bundle on the
   source → the Engine's clean GitHub build). If the Engine did not keep the name, stop (exit 13); a folder
   whose compose `x-app.instanceName` is not exactly `Nextcloud Demo` is refused (exit 11).
3. `startInstance` if it is not Running, then wait for the first-start self-install (exit 14 on timeout).
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

**Needs agent-engine-dev#221** (quote-aware `--name`, `--fresh`). An older Engine drops the name and the
script fails closed (exit 13). Office: each instance has its own CODE behind its own Nextcloud port
(no host port 9980), see docs/first-start.md.

Tests: `node --test tests/` (`tests/install-demo.test.mjs` mocks the Engine queue, occ and WebDAV).
