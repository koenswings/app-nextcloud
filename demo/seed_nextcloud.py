#!/usr/bin/env python3
"""Seed the Nextcloud Demo from an extracted demo pack (engine-dev#369, step 'seed').

Called by demo/hook.sh while the demo instance is RUNNING. It never starts, stops
or installs anything, never calls the Engine and never uses docker compose:
  - occ through `docker exec -u 33 <container> php occ ...`, where <container> is the
    nextcloud-app container of THIS instance's compose project
    (labels com.docker.compose.project=$IDEA_DEMO_COMPOSE_PROJECT and
    com.docker.compose.service=nextcloud-app), for users and groups;
  - WebDAV and the OCS share API on http://127.0.0.1:$IDEA_DEMO_PORT, as the file
    owner, for folders, files and shares.
It writes nothing to disk (no /tmp, no scratch files).

What it sets up (school password rule <account>911!):
  groups  teachers, learners, grade5a ("Grade 5A")
  users   admin (made by the first-start install; only checked), teacher1, teacher2
          (teachers), learner1..3 (learners + grade5a)
  files   teacher1  /Grade 5A/            <- pack Class/*
                    /Grade 5A/Worksheets/ <- pack Worksheets/*
                    /Teacher Notes/       <- pack Teacher Notes/*
          learnerN  /My work/             <- pack Learner Files/*
  shares  teacher1 /Grade 5A     -> group grade5a  (view only, 1)
          teacher1 /Grade 5A     -> group teachers (edit, 15)
          teacher1 /Teacher Notes-> group teachers (edit, 15)

Idempotent: a re-run adds only what is missing, puts a changed demo file back to
the pack version (same path, no copies), leaves extra files alone, never makes a
second share, and keeps passwords that were changed: an account that no longer
accepts <account>911! is skipped with a warning (usersSkipped), not an error.
IDEA_DEMO_RESET_PASSWORDS=1 resets the demo accounts to <account>911! first.

Env: IDEA_DEMO_PACK_DIR, IDEA_DEMO_PORT, IDEA_DEMO_COMPOSE_PROJECT (from the Engine).
Test/override env: NC_URL, NC_CONTAINER, DOCKER (default docker), OCC (command that
replaces "docker exec -u 33 <container> php occ"), IDEA_DEMO_READY_WAIT (s, default 900),
IDEA_DEMO_READY_STEP (s, default 5).
Exit codes: 0 ok | 2 bad env or pack | 14 not ready in time | 15 occ failed |
16 WebDAV failed | 17 share API failed. The last stdout line is a JSON summary.
"""
from __future__ import annotations

import base64, hashlib, json, os, shlex, subprocess, sys, time
import urllib.error, urllib.parse, urllib.request
from pathlib import Path

SUFFIX = "911!"
GROUPS = [("teachers", "teachers"), ("learners", "learners"), ("grade5a", "Grade 5A")]
USERS = [
    # uid, display name, groups
    ("teacher1", "Teacher 1", ["teachers"]),
    ("teacher2", "Teacher 2", ["teachers"]),
    ("learner1", "Learner 1", ["learners", "grade5a"]),
    ("learner2", "Learner 2", ["learners", "grade5a"]),
    ("learner3", "Learner 3", ["learners", "grade5a"]),
]
LEARNERS = [u for u, _, g in USERS if "grade5a" in g]
# (pack folder, owner(s), remote folder)
UPLOADS = [
    ("Class", ["teacher1"], "Grade 5A"),
    ("Worksheets", ["teacher1"], "Grade 5A/Worksheets"),
    ("Teacher Notes", ["teacher1"], "Teacher Notes"),
    ("Learner Files", LEARNERS, "My work"),
]
SHARES = [
    # owner, path, group, permissions (1 read, 15 read+update+create+delete)
    ("teacher1", "Grade 5A", "grade5a", 1),
    ("teacher1", "Grade 5A", "teachers", 15),
    ("teacher1", "Teacher Notes", "teachers", 15),
]
SHARE_API = "/ocs/v2.php/apps/files_sharing/api/v1/shares"


class AuthError(Exception):
    """A demo account no longer accepts <account>911! (its password was changed)."""


class SeedError(Exception):
    def __init__(self, code: int, text: str):
        super().__init__(text)
        self.code = code


def log(msg: str) -> None:
    print(f"seed: {msg}", file=sys.stderr, flush=True)


def password(uid: str) -> str:
    return f"{uid}{SUFFIX}"


# ── occ ──────────────────────────────────────────────────────────────────────

class Occ:
    def __init__(self, env: dict):
        self.override = env.get("OCC", "")
        self.docker = env.get("DOCKER", "docker")
        self.container = env.get("NC_CONTAINER", "")
        self.project = env.get("IDEA_DEMO_COMPOSE_PROJECT", "")

    def resolve(self) -> None:
        if self.override or self.container:
            return
        if not self.project:
            raise SeedError(2, "IDEA_DEMO_COMPOSE_PROJECT is required (the demo instance's compose project)")
        r = subprocess.run(shlex.split(self.docker) + [
            "ps", "-q",
            "--filter", f"label=com.docker.compose.project={self.project}",
            "--filter", "label=com.docker.compose.service=nextcloud-app",
        ], capture_output=True, text=True)
        ids = [l for l in r.stdout.split() if l.strip()]
        if r.returncode != 0 or len(ids) != 1:
            raise SeedError(15, f"expected one running nextcloud-app container in project {self.project}, found {len(ids)}"
                                + (f" ({r.stderr.strip()})" if r.stderr.strip() else ""))
        self.container = ids[0]

    def run(self, *args: str, secret: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        if secret is not None:
            env["OC_PASS"] = secret
        if self.override:
            cmd = shlex.split(self.override) + list(args)
        else:
            cmd = shlex.split(self.docker) + ["exec", "-u", "33"]
            if secret is not None:
                cmd += ["-e", "OC_PASS"]  # value from env, never on the command line
            cmd += [self.container, "php", "occ"] + list(args)
        r = subprocess.run(cmd, capture_output=True, text=True, env=env)
        if check and r.returncode != 0:
            tail = (r.stderr or r.stdout).strip().splitlines()[-3:]
            raise SeedError(15, f"occ {args[0]} failed ({r.returncode}): {' / '.join(tail)}")
        return r

    def json(self, *args: str):
        r = self.run(*args, "--output=json")
        try:
            return json.loads(r.stdout or "null")
        except json.JSONDecodeError as e:
            raise SeedError(15, f"occ {args[0]} did not return JSON: {e}")


# ── HTTP (WebDAV / OCS) ──────────────────────────────────────────────────────

class Http:
    def __init__(self, base: str):
        self.base = base.rstrip("/")

    def request(self, method: str, path: str, user: str, body: bytes | None = None,
                headers: dict | None = None) -> tuple[int, bytes]:
        h = {"Authorization": "Basic " + base64.b64encode(f"{user}:{password(user)}".encode()).decode()}
        h.update(headers or {})
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise AuthError(user)
            return e.code, e.read()
        except (urllib.error.URLError, OSError) as e:
            raise SeedError(16, f"{method} {path}: {e}")

    def dav(self, user: str, rel: str) -> str:
        return f"/remote.php/dav/files/{urllib.parse.quote(user)}/" + urllib.parse.quote(rel, safe="/")


def status_ok(http: Http) -> bool:
    try:
        req = urllib.request.Request(http.base + "/status.php")
        with urllib.request.urlopen(req, timeout=10) as res:
            st = json.loads(res.read() or b"{}")
    except Exception:
        return False
    return st.get("installed") is True and st.get("maintenance") is False and not st.get("needsDbUpgrade")


def occ_ready(occ: Occ) -> bool:
    r = occ.run("status", "--output=json", check=False)
    if r.returncode != 0:
        return False
    try:
        st = json.loads(r.stdout or "{}")
    except json.JSONDecodeError:
        return False
    return st.get("installed") is True and st.get("maintenance") is False


def wait_ready(occ: Occ, http: Http, wait: int, step: float) -> None:
    deadline = time.monotonic() + wait
    while True:
        if occ_ready(occ) and status_ok(http):
            return
        if time.monotonic() >= deadline:
            raise SeedError(14, f"Nextcloud was not installed and answering within {wait}s")
        time.sleep(step)


# ── steps ────────────────────────────────────────────────────────────────────

def seed_groups_users(occ: Occ, summary: dict, reset: bool) -> None:
    groups = occ.json("group:list") or {}
    for gid, display in GROUPS:
        if gid not in groups:
            occ.run("group:add", "--display-name", display, gid)
            groups[gid] = []
            summary["groupsCreated"].append(gid)
    users = occ.json("user:list") or {}
    if "admin" not in users:
        raise SeedError(15, "the admin account is missing: the first-start install did not finish")
    for uid, display, member_of in USERS:
        if uid not in users:
            args = ["user:add", "--password-from-env", "--display-name", display]
            for g in member_of:
                args += ["--group", g]
            occ.run(*args, uid, secret=password(uid))
            summary["usersCreated"].append(uid)
            for g in member_of:
                groups.setdefault(g, []).append(uid)
        else:
            if reset:
                occ.run("user:resetpassword", "--password-from-env", uid, secret=password(uid))
                summary["passwordsReset"].append(uid)
            if users.get(uid) != display:
                r = occ.run("user:modify", uid, "displayname", display, check=False)
                if r.returncode != 0:
                    log(f"WARNING could not set display name of {uid} (kept {users.get(uid)!r})")
        for g in member_of:
            if uid not in (groups.get(g) or []):
                occ.run("group:adduser", g, uid)
                groups.setdefault(g, []).append(uid)
                summary["membershipsAdded"].append(f"{g}:{uid}")


def ensure_folder(http: Http, user: str, rel: str, summary: dict) -> None:
    parts = rel.split("/")
    for i in range(1, len(parts) + 1):
        sub = "/".join(parts[:i])
        code, _ = http.request("PROPFIND", http.dav(user, sub), user, headers={"Depth": "0"})
        if code == 207:
            continue
        if code != 404:
            raise SeedError(16, f"PROPFIND {user}:/{sub} returned HTTP {code}")
        code, _ = http.request("MKCOL", http.dav(user, sub), user)
        if code not in (201, 405):  # 405: made meanwhile
            raise SeedError(16, f"MKCOL {user}:/{sub} returned HTTP {code}")
        summary["foldersCreated"].append(f"{user}:/{sub}")


def ensure_file(http: Http, user: str, rel: str, local: Path, summary: dict) -> None:
    body = local.read_bytes()
    want = hashlib.sha256(body).hexdigest()
    code, have = http.request("GET", http.dav(user, rel), user)
    if code == 200 and hashlib.sha256(have).hexdigest() == want:
        summary["filesUnchanged"] += 1
        return
    if code not in (200, 404):
        raise SeedError(16, f"GET {user}:/{rel} returned HTTP {code}")
    put, _ = http.request("PUT", http.dav(user, rel), user, body=body,
                          headers={"Content-Type": "application/octet-stream"})
    if put not in (200, 201, 204):
        raise SeedError(16, f"PUT {user}:/{rel} returned HTTP {put}")
    summary["filesRestored" if code == 200 else "filesUploaded"].append(f"{user}:/{rel}")


def skip_user(uid: str, summary: dict) -> None:
    if uid not in summary["usersSkipped"]:
        log(f"WARNING {uid} does not accept the demo password any more (changed?): its demo files and shares are left as they are")
        summary["usersSkipped"].append(uid)


def seed_files(http: Http, pack: Path, summary: dict) -> None:
    for folder, owners, remote in UPLOADS:
        src = pack / folder
        if not src.is_dir():
            raise SeedError(2, f"pack has no {folder}/ folder: {pack}")
        files = sorted(p for p in src.iterdir() if p.is_file())
        for owner in owners:
            if owner in summary["usersSkipped"]:
                continue
            try:
                ensure_folder(http, owner, remote, summary)
                for f in files:
                    ensure_file(http, owner, f"{remote}/{f.name}", f, summary)
            except AuthError:
                skip_user(owner, summary)


def ocs(http: Http, method: str, user: str, path: str, form: dict | None = None):
    body = urllib.parse.urlencode(form).encode() if form is not None else None
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    code, raw = http.request(method, path, user, body=body, headers=headers)
    try:
        doc = json.loads(raw or b"{}")
    except json.JSONDecodeError:
        raise SeedError(17, f"{method} {path}: HTTP {code}, not JSON")
    meta = (doc.get("ocs") or {}).get("meta") or {}
    if code != 200 or meta.get("statuscode") not in (100, 200):
        raise SeedError(17, f"{method} {path}: HTTP {code} {meta.get('statuscode')} {meta.get('message', '')}".strip())
    return (doc.get("ocs") or {}).get("data")


def seed_shares(http: Http, summary: dict) -> None:
    for owner, rel, group, perms in SHARES:
        if owner in summary["usersSkipped"]:
            continue
        try:
            ensure_share(http, owner, rel, group, perms, summary)
        except AuthError:
            skip_user(owner, summary)


def ensure_share(http: Http, owner: str, rel: str, group: str, perms: int, summary: dict) -> None:
    q = urllib.parse.urlencode({"path": "/" + rel, "reshares": "false", "format": "json"})
    existing = ocs(http, "GET", owner, f"{SHARE_API}?{q}") or []
    mine = [s for s in existing if int(s.get("share_type", -1)) == 1 and s.get("share_with") == group]
    if not mine:
        ocs(http, "POST", owner, f"{SHARE_API}?format=json",
            {"path": "/" + rel, "shareType": "1", "shareWith": group, "permissions": str(perms)})
        summary["sharesCreated"].append(f"{owner}:/{rel}->{group}")
        return
    if int(mine[0].get("permissions", -1)) != perms:
        ocs(http, "PUT", owner, f"{SHARE_API}/{mine[0]['id']}?format=json", {"permissions": str(perms)})
        summary["sharesUpdated"].append(f"{owner}:/{rel}->{group}")


def check_pack(pack: Path) -> None:
    pj = pack / "pack.json"
    if not pj.is_file():
        raise SeedError(2, f"no pack.json in {pack}")
    try:
        doc = json.loads(pj.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise SeedError(2, f"pack.json does not parse: {e}")
    if doc.get("app") != "nextcloud":
        raise SeedError(2, f"pack.json app is {doc.get('app')!r}, not 'nextcloud'")
    for f in doc.get("files") or []:
        if not (pack / f["path"]).is_file():
            raise SeedError(2, f"pack file missing: {f['path']}")


def main() -> int:
    env = os.environ
    summary = {k: [] for k in ("groupsCreated", "usersCreated", "passwordsReset", "membershipsAdded",
                               "foldersCreated", "filesUploaded", "filesRestored", "sharesCreated", "sharesUpdated",
                               "usersSkipped")}
    summary["filesUnchanged"] = 0
    try:
        pack_dir = env.get("IDEA_DEMO_PACK_DIR", "")
        if not pack_dir:
            raise SeedError(2, "IDEA_DEMO_PACK_DIR is required")
        pack = Path(pack_dir)
        check_pack(pack)
        base = env.get("NC_URL") or (f"http://127.0.0.1:{env['IDEA_DEMO_PORT']}" if env.get("IDEA_DEMO_PORT") else "")
        if not base:
            raise SeedError(2, "IDEA_DEMO_PORT is required for the seed step")
        occ = Occ(env)
        occ.resolve()
        http = Http(base)
        wait_ready(occ, http, int(env.get("IDEA_DEMO_READY_WAIT", "900")), float(env.get("IDEA_DEMO_READY_STEP", "5")))
        seed_groups_users(occ, summary, env.get("IDEA_DEMO_RESET_PASSWORDS") == "1")
        seed_files(http, pack, summary)
        seed_shares(http, summary)
    except SeedError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        print(json.dumps({"result": "failed", "code": e.code, **summary}))
        return e.code
    print(json.dumps({"result": "seeded", **summary}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
