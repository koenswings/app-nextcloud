#!/bin/sh
# hooks/usage.sh — Nextcloud usage hook (idea#413)
# Contract: koenswings/agent-engine-dev#308 docs/USAGE-CONTRACT.md
# Listed:  docker compose exec -T nextcloud-app /hooks/usage.sh day YYYY-MM-DD|sample
# Unlisted: docker exec -i <container> sh -s -- day YYYY-MM-DD|sample  < hooks/usage.sh
# Python path is used on the test box; PHP path is used inside the Nextcloud image.
if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python >/dev/null 2>&1; then PY=python
else PY=
fi
if [ -n "$PY" ]; then
exec "$PY" - "$@" <<'PY'
from __future__ import print_function

import datetime
import hashlib
import hmac
import json
import os
import re
import sqlite3
import sys

APP = "nextcloud"
FORBIDDEN = (
    "engine", "instance", "name", "listed", "clock",
    "collectedAt", "hookStatus", "skipReason",
)
PREFIX = os.environ.get("IDEA_USAGE_PREFIX") or "oc_"
TEACHERS = os.environ.get("IDEA_TEACHERS_GROUP") or "teachers"
# Seeds from docker-entrypoint-hooks.d/before-starting/20-idea-accounts.sh
# (IDEA_NC_SEED_USERS default teacher1:teachers learner1:learners) plus
# demo/install-demo.sh DEMO_USERS. Matched by username inside the hook only.


def emit(obj):
    for key in FORBIDDEN:
        obj.pop(key, None)
    sys.stdout.write(json.dumps(obj, separators=(",", ":"), ensure_ascii=False))
    sys.stdout.write("\n")


def args():
    mode = os.environ.get("IDEA_USAGE_MODE") or (sys.argv[1] if len(sys.argv) > 1 else "")
    day = os.environ.get("IDEA_USAGE_DAY") or (sys.argv[2] if len(sys.argv) > 2 else "")
    return mode, day


def t(name):
    return PREFIX + name


class Store(object):
    def __init__(self, path):
        self.conn = sqlite3.connect("file:%s?mode=ro" % path.replace("?", "%3F"), uri=True, timeout=0.5)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA query_only = ON")
        self.conn.execute("PRAGMA busy_timeout = 500")
        self.tables = {r[0] for r in self.conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}

    def has(self, name):
        return t(name) in self.tables

    def q(self, sql):
        try:
            return [dict(r) for r in self.conn.execute(sql)]
        except sqlite3.Error:
            return []

    def close(self):
        self.conn.close()


def open_store():
    path = os.environ.get("IDEA_USAGE_SQLITE")
    if path and os.path.isfile(path):
        return Store(path)
    return None


def iso_now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ts_to_day(val):
    if val is None or val == "":
        return None
    try:
        n = int(float(val))
    except (TypeError, ValueError):
        s = str(val)
        return s[:10] if re.match(r"^\d{4}-\d{2}-\d{2}", s) else None
    if n > 10 ** 12:
        n = n // 1000
    try:
        return datetime.datetime.utcfromtimestamp(n).strftime("%Y-%m-%d")
    except (OverflowError, OSError, ValueError):
        return None


def primary_group(groups):
    gs = set(groups or [])
    if "admin" in gs:
        return "admin"
    if TEACHERS in gs:
        return "teacher"
    return "learner"


def mime_kind(mt):
    mt = (mt or "").lower()
    if any(x in mt for x in ("opendocument.text", "wordprocessingml", "msword", "application/rtf", "text/rtf")):
        return "text"
    if any(x in mt for x in ("spreadsheet", "excel", "text/csv")):
        return "sheet"
    if any(x in mt for x in ("presentation", "powerpoint")):
        return "slides"
    return None


def user_groups(store):
    mapping = {}
    if store.has("group_user"):
        for row in store.q("SELECT uid, gid FROM %s" % t("group_user")):
            mapping.setdefault(str(row["uid"]), []).append(str(row["gid"]))
    users = set()
    if store.has("users"):
        for row in store.q("SELECT uid FROM %s" % t("users")):
            users.add(str(row["uid"]))
    for uid in mapping:
        users.add(uid)
    return users, mapping


def seed_names():
    """Return {admin, teacher, learner} sets of seed usernames. Never emitted."""
    admin = os.environ.get("NEXTCLOUD_ADMIN_USER") or "admin"
    names = {"admin": {admin}, "teacher": set(), "learner": set()}
    raw = os.environ.get("IDEA_NC_SEED_USERS")
    if raw is None:
        raw = "teacher1:teachers learner1:learners"
    parts = list(raw.split())
    # demo/install-demo.sh DEMO_USERS extras (same repo fixtures)
    parts.extend(["teacher2:teachers", "learner2:learners", "learner3:learners"])
    for part in parts:
        if ":" not in part:
            continue
        user, group = part.split(":", 1)
        user, group = user.strip(), group.strip()
        if not user:
            continue
        if group == "admin":
            names["admin"].add(user)
        elif group == TEACHERS:
            names["teacher"].add(user)
        elif group == "learners":
            names["learner"].add(user)
    return names


def role_count(uids, seeds):
    total = len(uids)
    seeded = sum(1 for uid in uids if uid in seeds)
    return {"total": total, "beyondSeed": total - seeded}


def empty_role():
    return {"total": 0, "beyondSeed": 0}


def setup_from_groups(users, mapping):
    counted = {"admin": set(), "teacher": set(), "learner": set()}
    other = {}
    for uid in users:
        gs = mapping.get(uid, [])
        if "admin" in gs:
            counted["admin"].add(uid)
        if TEACHERS in gs:
            counted["teacher"].add(uid)
        if "learners" in gs:
            counted["learner"].add(uid)
        for g in gs:
            if g not in ("admin", TEACHERS, "learners"):
                other.setdefault(g, set()).add(uid)
    seeds = seed_names()
    return {
        "admin": role_count(counted["admin"], seeds["admin"]),
        "teacher": role_count(counted["teacher"], seeds["teacher"]),
        "learner": role_count(counted["learner"], seeds["learner"]),
        "otherGroups": {g: len(s) for g, s in sorted(other.items())},
    }


def last_logins(store):
    out = {}
    if store.has("preferences"):
        for row in store.q(
            "SELECT userid, configvalue FROM %s WHERE appid='login' AND configkey='lastLogin'"
            % t("preferences")
        ):
            out[str(row["userid"])] = row["configvalue"]
    return out


def instance_salt():
    """Per-instance HMAC key. Never emitted. Prefer Nextcloud instanceid or IDEA_USAGE_INSTANCE_SALT."""
    env = os.environ.get("IDEA_USAGE_INSTANCE_SALT")
    if env:
        return env.encode("utf-8")
    for path in (os.environ.get("IDEA_USAGE_CONFIG") or "", "/var/www/html/config/config.php"):
        if path and os.path.isfile(path):
            try:
                text = open(path, "r", encoding="utf-8", errors="replace").read()
            except OSError:
                text = ""
            m = re.search(r"['\"]instanceid['\"]\s*=>\s*['\"]([^'\"]+)['\"]", text)
            if m:
                return m.group(1).encode("utf-8")
    sqlite = os.environ.get("IDEA_USAGE_SQLITE") or ""
    if sqlite:
        return hmac.new(b"idea-usage", sqlite.encode("utf-8"), hashlib.sha256).digest()
    return b"idea-usage"


def opaque_file_id(fileid, salt):
    """HMAC-SHA256 of the WOPI fileId, truncated. Never a name or path."""
    return hmac.new(salt, str(fileid).encode("utf-8"), hashlib.sha256).hexdigest()[:16]


def office_from_wopi(store, mapping, day=None):
    result = {
        "tokens": 0, "opens": 0, "distinctDocuments": 0, "read": 0, "edit": 0,
        "estimatedMinutes": 0,
        "byGroup": {"admin": 0, "teacher": 0, "learner": 0},
        "mime": {"text": 0, "sheet": 0, "slides": 0},
        "documentIds": [],
    }
    if not store.has("richdocuments_wopi"):
        return result
    rows = store.q("SELECT * FROM %s" % t("richdocuments_wopi"))
    mime_of = {}
    if store.has("filecache") and store.has("mimetypes"):
        files = store.q("SELECT fileid, mimetype FROM %s" % t("filecache"))
        types = {str(r["id"]): r["mimetype"] for r in store.q("SELECT id, mimetype FROM %s" % t("mimetypes"))}
        for f in files:
            mime_of[str(f["fileid"])] = types.get(str(f["mimetype"]), "")
    docs = set()
    hashed = set()
    salt = instance_salt()
    for row in rows:
        expiry = row.get("expiry")
        ttl = row.get("token_ttl") or row.get("token_ttl".upper())
        opened_day = None
        try:
            if expiry is not None and ttl is not None:
                opened_day = ts_to_day(int(float(expiry)) - int(float(ttl)))
            elif expiry is not None:
                opened_day = ts_to_day(expiry)
        except (TypeError, ValueError):
            opened_day = ts_to_day(expiry)
        if day and opened_day and opened_day != day:
            continue
        result["tokens"] += 1
        result["opens"] += 1
        fileid = str(row.get("fileid") or "")
        if fileid:
            docs.add(fileid)
            hashed.add(opaque_file_id(fileid, salt))
        canwrite = row.get("canwrite")
        if canwrite in (1, "1", True, "true", "True"):
            result["edit"] += 1
        else:
            result["read"] += 1
        editor = row.get("editor_uid") or row.get("owner_uid")
        grp = primary_group(mapping.get(str(editor), []) if editor else [])
        result["byGroup"][grp] = result["byGroup"].get(grp, 0) + 1
        kind = mime_kind(mime_of.get(fileid, ""))
        if kind:
            result["mime"][kind] += 1
    result["distinctDocuments"] = len(hashed) if hashed else len(docs)
    result["documentIds"] = sorted(hashed)
    return result


def workflows(store, day):
    out = {
        "worksheetShares": 0, "editShares": 0,
        "fileDropLinks": 0, "fileDropUploads": 0, "schoolFilesShares": 0,
    }
    if not store.has("share"):
        return out
    shares = store.q("SELECT * FROM %s" % t("share"))
    file_storage = {}
    storage_ids = {}
    parent_of = {}
    mtime_of = {}
    if store.has("filecache"):
        for f in store.q("SELECT fileid, storage, parent, storage_mtime FROM %s" % t("filecache")):
            file_storage[str(f["fileid"])] = f.get("storage")
            parent_of[str(f["fileid"])] = str(f.get("parent") or "")
            mtime_of[str(f["fileid"])] = f.get("storage_mtime")
    if store.has("storages"):
        for s in store.q("SELECT numeric_id, id FROM %s" % t("storages")):
            storage_ids[str(s["numeric_id"])] = str(s.get("id") or "")
    drop_parents = set()
    for s in shares:
        stime_day = ts_to_day(s.get("stime"))
        try:
            perm = int(s.get("permissions") or 0)
        except (TypeError, ValueError):
            perm = 0
        try:
            stype = int(s.get("share_type") or -1)
        except (TypeError, ValueError):
            stype = -1
        share_with = str(s.get("share_with") or "")
        item = str(s.get("item_source") or "")
        is_drop = stype == 3 and (perm & 4) and not (perm & 2)
        if is_drop:
            drop_parents.add(item)
        sid = storage_ids.get(str(file_storage.get(item, "")), "")
        is_school = sid.startswith("local::/mnt/idea-files")
        if stime_day == day:
            if stype == 1 and (perm & 1) and not (perm & 2) and share_with not in ("admin", TEACHERS) and not is_school:
                out["worksheetShares"] += 1
            if perm & 2:
                out["editShares"] += 1
            if is_drop:
                out["fileDropLinks"] += 1
            if is_school:
                out["schoolFilesShares"] += 1
    for fid, parent in parent_of.items():
        if parent in drop_parents and ts_to_day(mtime_of.get(fid)) == day:
            out["fileDropUploads"] += 1
    return out


def day_payload(store, day):
    users, mapping = user_groups(store)
    setup = setup_from_groups(users, mapping)
    seeds = seed_names()
    login_seen = {"admin": set(), "teacher": set(), "learner": set()}
    for uid, val in last_logins(store).items():
        if ts_to_day(val) != day:
            continue
        grp = primary_group(mapping.get(uid, []))
        login_seen[grp].add(uid)
    logins = {grp: role_count(login_seen[grp], seeds[grp]) for grp in ("admin", "teacher", "learner")}
    office = office_from_wopi(store, mapping, day)
    day_office = {
        "opens": office["opens"],
        "distinctDocuments": office["distinctDocuments"],
        "read": office["read"],
        "edit": office["edit"],
        "estimatedMinutes": office["estimatedMinutes"],
        "byGroup": office["byGroup"],
        "mime": office["mime"],
    }
    return {
        "schema": "idea-usage-day/1",
        "day": day,
        "app": APP,
        "demo": False,
        "setup": setup,
        "logins": logins,
        "office": day_office,
        "workflows": workflows(store, day),
    }


def sample_payload(store):
    users, mapping = user_groups(store)
    office = office_from_wopi(store, mapping, day=None)
    return {
        "schema": "idea-usage-sample/1",
        "app": APP,
        "sampledAt": iso_now(),
        "office": {
            "tokens": office["tokens"],
            "documentIds": office.get("documentIds") or [],
            "distinctDocuments": office["distinctDocuments"],
            "read": office["read"],
            "edit": office["edit"],
            "byGroup": office["byGroup"],
            "mime": office["mime"],
        },
    }


def main():
    mode, day = args()
    store = open_store()
    if store is None:
        emit(
            {"schema": "idea-usage-sample/1", "app": APP, "supported": False}
            if mode == "sample"
            else {
                "schema": "idea-usage-day/1", "day": day or "", "app": APP, "demo": False,
                "setup": {"admin": empty_role(), "teacher": empty_role(), "learner": empty_role(), "otherGroups": {}},
                "logins": {"admin": empty_role(), "teacher": empty_role(), "learner": empty_role()},
                "office": {
                    "opens": 0, "distinctDocuments": 0, "read": 0, "edit": 0,
                    "estimatedMinutes": 0,
                    "byGroup": {"admin": 0, "teacher": 0, "learner": 0},
                    "mime": {"text": 0, "sheet": 0, "slides": 0},
                },
                "workflows": {
                    "worksheetShares": 0, "editShares": 0,
                    "fileDropLinks": 0, "fileDropUploads": 0, "schoolFilesShares": 0,
                },
            }
            if mode == "day" and re.match(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$", day or "")
            else None
        ) if False else None
        if mode == "sample":
            emit({"schema": "idea-usage-sample/1", "app": APP, "sampledAt": iso_now(),
                  "office": {"tokens": 0, "documentIds": [], "distinctDocuments": 0, "read": 0, "edit": 0,
                             "byGroup": {"admin": 0, "teacher": 0, "learner": 0},
                             "mime": {"text": 0, "sheet": 0, "slides": 0}}})
            return 0
        if mode != "day" or not re.match(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$", day or ""):
            sys.stderr.write("invalid arguments\n")
            return 2
        emit(day_payload(type("S", (), {"has": lambda self, n: False, "q": lambda self, s: []})(), day) if False else {
            "schema": "idea-usage-day/1", "day": day, "app": APP, "demo": False,
            "setup": {"admin": empty_role(), "teacher": empty_role(), "learner": empty_role(), "otherGroups": {}},
            "logins": {"admin": empty_role(), "teacher": empty_role(), "learner": empty_role()},
            "office": {"opens": 0, "distinctDocuments": 0, "read": 0, "edit": 0, "estimatedMinutes": 0,
                       "byGroup": {"admin": 0, "teacher": 0, "learner": 0},
                       "mime": {"text": 0, "sheet": 0, "slides": 0}},
            "workflows": {"worksheetShares": 0, "editShares": 0, "fileDropLinks": 0,
                          "fileDropUploads": 0, "schoolFilesShares": 0},
        })
        return 0
    try:
        if mode == "sample":
            emit(sample_payload(store))
            return 0
        if mode != "day" or not re.match(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$", day or ""):
            sys.stderr.write("invalid arguments\n")
            return 2
        emit(day_payload(store, day))
        return 0
    finally:
        store.close()


if __name__ == "__main__":
    sys.exit(main())
PY
fi
# PHP fallback for the official Nextcloud image (no Python).
if ! command -v php >/dev/null 2>&1; then
  echo "usage hook: python or php required" >&2
  exit 1
fi
exec php -- "$@" <<'PHP'
<?php
function emit($obj) {
    foreach (array('engine','instance','name','listed','clock','collectedAt','hookStatus','skipReason') as $k) {
        unset($obj[$k]);
    }
    echo json_encode($obj, JSON_UNESCAPED_UNICODE);
    echo "\n";
}
$mode = getenv('IDEA_USAGE_MODE') ?: (isset($argv[1]) ? $argv[1] : '');
$day = getenv('IDEA_USAGE_DAY') ?: (isset($argv[2]) ? $argv[2] : '');
$prefix = getenv('IDEA_USAGE_PREFIX') ?: 'oc_';
$teachers = getenv('IDEA_TEACHERS_GROUP') ?: 'teachers';

function pdo_connect() {
    $sqlite = getenv('IDEA_USAGE_SQLITE');
    if ($sqlite && is_file($sqlite)) {
        $pdo = new PDO('sqlite:' . $sqlite, null, null, array(PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION));
        $pdo->exec('PRAGMA query_only = ON');
        $pdo->exec('PRAGMA busy_timeout = 500');
        return $pdo;
    }
    $host = getenv('MYSQL_HOST') ?: 'nextcloud-db';
    $db = getenv('MYSQL_DATABASE') ?: 'nextcloud';
    $user = getenv('MYSQL_USER') ?: 'nextcloud';
    $pass = getenv('MYSQL_PASSWORD') ?: '';
    $cfg = '/var/www/html/config/config.php';
    if (is_file($cfg)) {
        $CONFIG = array();
        include $cfg;
        if (!empty($CONFIG['dbhost'])) $host = $CONFIG['dbhost'];
        if (!empty($CONFIG['dbname'])) $db = $CONFIG['dbname'];
        if (!empty($CONFIG['dbuser'])) $user = $CONFIG['dbuser'];
        if (isset($CONFIG['dbpassword'])) $pass = $CONFIG['dbpassword'];
        if (!empty($CONFIG['dbtableprefix'])) $GLOBALS['prefix'] = $CONFIG['dbtableprefix'];
        if (!empty($CONFIG['instanceid'])) $GLOBALS['instanceSalt'] = $CONFIG['instanceid'];
    }
    $dsn = 'mysql:host=' . $host . ';dbname=' . $db . ';charset=utf8mb4';
    $pdo = new PDO($dsn, $user, $pass, array(PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION));
    try { $pdo->exec('SET SESSION TRANSACTION READ ONLY'); } catch (Exception $e) {}
    return $pdo;
}

function q($pdo, $sql) {
    try { return $pdo->query($sql)->fetchAll(PDO::FETCH_ASSOC); }
    catch (Exception $e) { return array(); }
}

$prefix = getenv('IDEA_USAGE_PREFIX') ?: 'oc_';
try {
    $pdo = pdo_connect();
} catch (Exception $e) {
    $pdo = null;
}
if (isset($GLOBALS['prefix'])) $prefix = $GLOBALS['prefix'];

function ts_day($val) {
    if ($val === null || $val === '') return null;
    if (!is_numeric($val)) {
        return preg_match('/^\\d{4}-\\d{2}-\\d{2}/', (string)$val) ? substr((string)$val, 0, 10) : null;
    }
    $n = intval($val);
    if ($n > 1000000000000) $n = intdiv($n, 1000);
    return gmdate('Y-m-d', $n);
}
function primary_group($gs, $teachers) {
    if (in_array('admin', $gs, true)) return 'admin';
    if (in_array($teachers, $gs, true)) return 'teacher';
    return 'learner';
}
function mime_kind($mt) {
    $mt = strtolower((string)$mt);
    foreach (array('opendocument.text','wordprocessingml','msword','application/rtf','text/rtf') as $x)
        if (strpos($mt, $x) !== false) return 'text';
    foreach (array('spreadsheet','excel','text/csv') as $x)
        if (strpos($mt, $x) !== false) return 'sheet';
    foreach (array('presentation','powerpoint') as $x)
        if (strpos($mt, $x) !== false) return 'slides';
    return null;
}

$mapping = array();
$users = array();
if ($pdo) {
    foreach (q($pdo, "SELECT uid, gid FROM {$prefix}group_user") as $r) {
        $mapping[(string)$r['uid']][] = (string)$r['gid'];
        $users[(string)$r['uid']] = true;
    }
    foreach (q($pdo, "SELECT uid FROM {$prefix}users") as $r) $users[(string)$r['uid']] = true;
}
function seed_names_php($teachers) {
    $admin = getenv('NEXTCLOUD_ADMIN_USER') ?: 'admin';
    $names = array('admin' => array($admin => true), 'teacher' => array(), 'learner' => array());
    $raw = getenv('IDEA_NC_SEED_USERS');
    if ($raw === false) $raw = 'teacher1:teachers learner1:learners';
    $parts = preg_split('/\s+/', trim($raw . ' teacher2:teachers learner2:learners learner3:learners'));
    foreach ($parts as $part) {
        if (strpos($part, ':') === false) continue;
        list($user, $group) = explode(':', $part, 2);
        $user = trim($user); $group = trim($group);
        if ($user === '') continue;
        if ($group === 'admin') $names['admin'][$user] = true;
        elseif ($group === $teachers) $names['teacher'][$user] = true;
        elseif ($group === 'learners') $names['learner'][$user] = true;
    }
    return $names;
}
function role_count_php($uids, $seeds) {
    $total = count($uids);
    $seeded = 0;
    foreach ($uids as $uid => $_) {
        if (isset($seeds[$uid])) $seeded++;
    }
    return array('total' => $total, 'beyondSeed' => $total - $seeded);
}
function setup_from($users, $mapping, $teachers) {
    $a = $t = $l = array(); $other = array();
    foreach (array_keys($users) as $uid) {
        $gs = isset($mapping[$uid]) ? $mapping[$uid] : array();
        if (in_array('admin', $gs, true)) $a[$uid] = true;
        if (in_array($teachers, $gs, true)) $t[$uid] = true;
        if (in_array('learners', $gs, true)) $l[$uid] = true;
        foreach ($gs as $g) {
            if ($g !== 'admin' && $g !== $teachers && $g !== 'learners') {
                if (!isset($other[$g])) $other[$g] = array();
                $other[$g][$uid] = true;
            }
        }
    }
    $og = array();
    ksort($other);
    foreach ($other as $g => $set) $og[$g] = count($set);
    $seeds = seed_names_php($teachers);
    return array(
        'admin' => role_count_php($a, $seeds['admin']),
        'teacher' => role_count_php($t, $seeds['teacher']),
        'learner' => role_count_php($l, $seeds['learner']),
        'otherGroups' => $og,
    );
}
function instance_salt_php() {
    $env = getenv('IDEA_USAGE_INSTANCE_SALT');
    if ($env) return $env;
    if (!empty($GLOBALS['instanceSalt'])) return $GLOBALS['instanceSalt'];
    return 'idea-usage';
}
function opaque_file_id($fileid, $salt) {
    return substr(hash_hmac('sha256', (string)$fileid, $salt), 0, 16);
}
function office_from($pdo, $prefix, $mapping, $teachers, $day) {
    $r = array('tokens'=>0,'opens'=>0,'distinctDocuments'=>0,'read'=>0,'edit'=>0,'estimatedMinutes'=>0,
        'byGroup'=>array('admin'=>0,'teacher'=>0,'learner'=>0),
        'mime'=>array('text'=>0,'sheet'=>0,'slides'=>0),
        'documentIds'=>array());
    $rows = q($pdo, "SELECT * FROM {$prefix}richdocuments_wopi");
    $mimeOf = array();
    $types = array();
    foreach (q($pdo, "SELECT id, mimetype FROM {$prefix}mimetypes") as $m) $types[(string)$m['id']] = $m['mimetype'];
    foreach (q($pdo, "SELECT fileid, mimetype FROM {$prefix}filecache") as $f)
        $mimeOf[(string)$f['fileid']] = isset($types[(string)$f['mimetype']]) ? $types[(string)$f['mimetype']] : '';
    $docs = array();
    $hashed = array();
    $salt = instance_salt_php();
    foreach ($rows as $row) {
        $opened = null;
        if (isset($row['expiry']) && isset($row['token_ttl'])) $opened = ts_day(intval($row['expiry']) - intval($row['token_ttl']));
        elseif (isset($row['expiry'])) $opened = ts_day($row['expiry']);
        if ($day && $opened && $opened !== $day) continue;
        $r['tokens']++; $r['opens']++;
        $fileid = isset($row['fileid']) ? (string)$row['fileid'] : '';
        if ($fileid) {
            $docs[$fileid] = true;
            $hashed[opaque_file_id($fileid, $salt)] = true;
        }
        $can = isset($row['canwrite']) ? $row['canwrite'] : 0;
        if ($can === 1 || $can === '1' || $can === true) $r['edit']++; else $r['read']++;
        $editor = isset($row['editor_uid']) ? $row['editor_uid'] : (isset($row['owner_uid']) ? $row['owner_uid'] : '');
        $grp = primary_group(isset($mapping[(string)$editor]) ? $mapping[(string)$editor] : array(), $teachers);
        $r['byGroup'][$grp] = isset($r['byGroup'][$grp]) ? $r['byGroup'][$grp] + 1 : 1;
        $mk = mime_kind(isset($mimeOf[$fileid]) ? $mimeOf[$fileid] : '');
        if ($mk) $r['mime'][$mk]++;
    }
    $r['distinctDocuments'] = count($hashed) ? count($hashed) : count($docs);
    $ids = array_keys($hashed);
    sort($ids);
    $r['documentIds'] = $ids;
    return $r;
}

if ($mode === 'sample') {
    $office = $pdo ? office_from($pdo, $prefix, $mapping, $teachers, null) : array(
        'tokens'=>0,'distinctDocuments'=>0,'read'=>0,'edit'=>0,
        'byGroup'=>array('admin'=>0,'teacher'=>0,'learner'=>0),
        'mime'=>array('text'=>0,'sheet'=>0,'slides'=>0));
    emit(array('schema'=>'idea-usage-sample/1','app'=>'nextcloud','sampledAt'=>gmdate('Y-m-d\\TH:i:s\\Z'),
        'office'=>array('tokens'=>$office['tokens'],'documentIds'=>isset($office['documentIds'])?$office['documentIds']:array(),'distinctDocuments'=>$office['distinctDocuments'],'read'=>$office['read'],'edit'=>$office['edit'],'byGroup'=>$office['byGroup'],'mime'=>$office['mime'])));
    exit(0);
}
if ($mode !== 'day' || !preg_match('/^\\d{4}-\\d{2}-\\d{2}$/', $day)) {
    fwrite(STDERR, "invalid arguments\n");
    exit(2);
}
$emptyRole = array('total'=>0,'beyondSeed'=>0);
$setup = $pdo ? setup_from($users, $mapping, $teachers) : array('admin'=>$emptyRole,'teacher'=>$emptyRole,'learner'=>$emptyRole,'otherGroups'=>array());
$seeds = seed_names_php($teachers);
$logins = array('admin'=>$emptyRole,'teacher'=>$emptyRole,'learner'=>$emptyRole);
if ($pdo) {
    $seen = array('admin'=>array(),'teacher'=>array(),'learner'=>array());
    foreach (q($pdo, "SELECT userid, configvalue FROM {$prefix}preferences WHERE appid='login' AND configkey='lastLogin'") as $row) {
        if (ts_day($row['configvalue']) !== $day) continue;
        $uid = (string)$row['userid'];
        $g = primary_group(isset($mapping[$uid]) ? $mapping[$uid] : array(), $teachers);
        $seen[$g][$uid] = true;
    }
    foreach (array('admin','teacher','learner') as $g) $logins[$g] = role_count_php($seen[$g], $seeds[$g]);
}
$office = $pdo ? office_from($pdo, $prefix, $mapping, $teachers, $day) : array(
    'opens'=>0,'distinctDocuments'=>0,'read'=>0,'edit'=>0,'estimatedMinutes'=>0,
    'byGroup'=>array('admin'=>0,'teacher'=>0,'learner'=>0),'mime'=>array('text'=>0,'sheet'=>0,'slides'=>0));
$wf = array('worksheetShares'=>0,'editShares'=>0,'fileDropLinks'=>0,'fileDropUploads'=>0,'schoolFilesShares'=>0);
if ($pdo) {
    $shares = q($pdo, "SELECT * FROM {$prefix}share");
    $fileStorage = $parentOf = $mtimeOf = $storageIds = array();
    foreach (q($pdo, "SELECT fileid, storage, parent, storage_mtime FROM {$prefix}filecache") as $f) {
        $fileStorage[(string)$f['fileid']] = $f['storage'];
        $parentOf[(string)$f['fileid']] = (string)$f['parent'];
        $mtimeOf[(string)$f['fileid']] = $f['storage_mtime'];
    }
    foreach (q($pdo, "SELECT numeric_id, id FROM {$prefix}storages") as $s) $storageIds[(string)$s['numeric_id']] = (string)$s['id'];
    $drops = array();
    foreach ($shares as $s) {
        $stimeDay = ts_day(isset($s['stime']) ? $s['stime'] : null);
        $perm = intval(isset($s['permissions']) ? $s['permissions'] : 0);
        $stype = intval(isset($s['share_type']) ? $s['share_type'] : -1);
        $with = isset($s['share_with']) ? (string)$s['share_with'] : '';
        $item = isset($s['item_source']) ? (string)$s['item_source'] : '';
        $isDrop = ($stype === 3 && ($perm & 4) && !($perm & 2));
        if ($isDrop) $drops[$item] = true;
        $sid = isset($storageIds[(string)(isset($fileStorage[$item]) ? $fileStorage[$item] : '')]) ? $storageIds[(string)$fileStorage[$item]] : '';
        $isSchool = (strpos($sid, 'local::/mnt/idea-files') === 0);
        if ($stimeDay === $day) {
            if ($stype === 1 && ($perm & 1) && !($perm & 2) && $with !== 'admin' && $with !== $teachers && !$isSchool) $wf['worksheetShares']++;
            if ($perm & 2) $wf['editShares']++;
            if ($isDrop) $wf['fileDropLinks']++;
            if ($isSchool) $wf['schoolFilesShares']++;
        }
    }
    foreach ($parentOf as $fid => $parent) {
        if (isset($drops[$parent]) && ts_day(isset($mtimeOf[$fid]) ? $mtimeOf[$fid] : null) === $day) $wf['fileDropUploads']++;
    }
}
emit(array(
    'schema'=>'idea-usage-day/1','day'=>$day,'app'=>'nextcloud','demo'=>false,
    'setup'=>$setup,'logins'=>$logins,
    'office'=>array('opens'=>$office['opens'],'distinctDocuments'=>$office['distinctDocuments'],
        'read'=>$office['read'],'edit'=>$office['edit'],'estimatedMinutes'=>isset($office['estimatedMinutes'])?$office['estimatedMinutes']:0,
        'byGroup'=>$office['byGroup'],'mime'=>$office['mime']),
    'workflows'=>$wf,
));
PHP
