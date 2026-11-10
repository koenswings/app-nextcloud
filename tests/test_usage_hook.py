"""Unit tests for hooks/usage.sh (idea#413). Run: python3 -m unittest tests.test_usage_hook"""
import json
import os
import sqlite3
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = os.path.join(ROOT, "hooks", "usage.sh")
DAY = "2026-11-12"
FORBIDDEN = {
    "engine", "instance", "name", "listed", "clock",
    "collectedAt", "hookStatus", "skipReason",
}


def run_hook(db, args, extra_env=None):
    env = os.environ.copy()
    env["IDEA_USAGE_SQLITE"] = db
    env["IDEA_USAGE_PREFIX"] = "oc_"
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        ["sh", HOOK] + list(args),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=env, timeout=20,
    )


def parse(proc):
    obj = json.loads(proc.stdout.decode("utf-8"))
    return obj


def build_db(path):
    conn = sqlite3.connect(path)
    conn.executescript("""
    CREATE TABLE oc_users (uid TEXT PRIMARY KEY);
    CREATE TABLE oc_group_user (uid TEXT, gid TEXT);
    CREATE TABLE oc_preferences (userid TEXT, appid TEXT, configkey TEXT, configvalue TEXT);
    CREATE TABLE oc_richdocuments_wopi (
        id INTEGER, owner_uid TEXT, editor_uid TEXT, fileid INTEGER,
        canwrite INTEGER, expiry INTEGER, token_ttl INTEGER
    );
    CREATE TABLE oc_filecache (
        fileid INTEGER PRIMARY KEY, storage INTEGER, parent INTEGER,
        path TEXT, storage_mtime INTEGER, mimetype INTEGER
    );
    CREATE TABLE oc_mimetypes (id INTEGER PRIMARY KEY, mimetype TEXT);
    CREATE TABLE oc_share (
        id INTEGER, share_type INTEGER, share_with TEXT, uid_owner TEXT,
        permissions INTEGER, stime INTEGER, item_source INTEGER, file_target TEXT
    );
    CREATE TABLE oc_storages (numeric_id INTEGER PRIMARY KEY, id TEXT);
    """)
    conn.executemany("INSERT INTO oc_users VALUES (?)", [("admin",), ("teacher1",), ("learner1",), ("learner2",), ("thabo",)])
    conn.executemany("INSERT INTO oc_group_user VALUES (?,?)", [
        ("admin", "admin"),
        ("teacher1", "teachers"),
        ("learner1", "learners"),
        ("learner2", "learners"),
        ("thabo", "learners"),
        ("learner1", "Grade 5"),
    ])
    # lastLogin: seconds for 2026-11-12 10:00:00 UTC = 1762941600? use known
    # We'll compute: datetime(2026,11,12,10,0,0) UTC
    import datetime
    login_ts = int(datetime.datetime(2026, 11, 12, 10, 0, 0).timestamp())
    old_ts = int(datetime.datetime(2026, 11, 10, 10, 0, 0).timestamp())
    conn.execute(
        "INSERT INTO oc_preferences VALUES (?,?,?,?)",
        ("teacher1", "login", "lastLogin", str(login_ts)),
    )
    conn.execute(
        "INSERT INTO oc_preferences VALUES (?,?,?,?)",
        ("learner1", "login", "lastLogin", str(old_ts)),
    )
    conn.execute("INSERT INTO oc_mimetypes VALUES (1, 'application/vnd.oasis.opendocument.text')")
    conn.execute("INSERT INTO oc_mimetypes VALUES (2, 'application/vnd.oasis.opendocument.spreadsheet')")
    conn.execute("INSERT INTO oc_filecache VALUES (10, 1, 0, 'files/worksheet.odt', 1762941600, 1)")
    conn.execute("INSERT INTO oc_filecache VALUES (11, 1, 0, 'files/sheet.ods', 1762941600, 2)")
    conn.execute("INSERT INTO oc_filecache VALUES (20, 1, 0, 'files/drop', 1762940000, 1)")
    conn.execute("INSERT INTO oc_filecache VALUES (21, 1, 20, 'files/drop/upload.txt', ?, 1)", (login_ts,))
    conn.execute("INSERT INTO oc_filecache VALUES (30, 2, 0, 'School Files/notes.odt', ?, 1)", (login_ts,))
    conn.execute("INSERT INTO oc_storages VALUES (1, 'home::teacher1')")
    conn.execute("INSERT INTO oc_storages VALUES (2, 'local::/mnt/idea-files/School Files/')")
    # WOPI token opened on DAY: expiry = open + ttl
    conn.execute(
        "INSERT INTO oc_richdocuments_wopi VALUES (1,'teacher1','teacher1',10,1,?,3600)",
        (login_ts + 3600,),
    )
    conn.execute(
        "INSERT INTO oc_richdocuments_wopi VALUES (2,'learner1','learner1',11,0,?,3600)",
        (login_ts + 3600,),
    )
    # worksheet share (group read-only to learners)
    conn.execute("INSERT INTO oc_share VALUES (1,1,'learners','teacher1',1,?,10,'/worksheet.odt')", (login_ts,))
    # edit share
    conn.execute("INSERT INTO oc_share VALUES (2,1,'teachers','admin',31,?,10,'/worksheet.odt')", (login_ts,))
    # file-drop link (create only)
    conn.execute("INSERT INTO oc_share VALUES (3,3,'','teacher1',4,?,20,'/drop')", (login_ts,))
    # school files share
    conn.execute("INSERT INTO oc_share VALUES (4,1,'learners','teacher1',1,?,30,'/notes.odt')", (login_ts,))
    conn.commit()
    conn.close()


class UsageHookTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "nc.sqlite")
        build_db(self.db)

    def test_sample_office(self):
        proc = run_hook(self.db, ["sample"])
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        obj = parse(proc)
        self.assertEqual(obj["schema"], "idea-usage-sample/1")
        self.assertEqual(obj["app"], "nextcloud")
        self.assertTrue(FORBIDDEN.isdisjoint(obj))
        self.assertEqual(obj["office"]["tokens"], 2)
        self.assertEqual(obj["office"]["distinctDocuments"], 2)
        self.assertEqual(obj["office"]["edit"], 1)
        self.assertEqual(obj["office"]["read"], 1)
        self.assertEqual(obj["office"]["mime"]["text"], 1)
        self.assertEqual(obj["office"]["mime"]["sheet"], 1)
        self.assertEqual(obj["office"]["byGroup"]["teacher"], 1)
        self.assertEqual(obj["office"]["byGroup"]["learner"], 1)
        self.assertNotIn("teachers", obj["office"]["byGroup"])
        self.assertNotIn("learners", obj["office"]["byGroup"])
        ids = obj["office"]["documentIds"]
        self.assertEqual(len(ids), 2)
        self.assertEqual(len(set(ids)), 2)
        for hid in ids:
            self.assertRegex(hid, r"^[0-9a-f]{16}$")
            self.assertNotIn(hid, ("10", "11"))
        out = proc.stdout.decode()
        self.assertNotIn("teacher1", out)
        self.assertNotIn("learner1", out)
        self.assertNotIn("worksheet.odt", out)
        self.assertNotIn("files/", out)
        # Same salt is stable; a different instance salt must not match.
        import hmac, hashlib
        salt = b"test-salt-a"
        proc_a = run_hook(self.db, ["sample"], extra_env={"IDEA_USAGE_INSTANCE_SALT": "test-salt-a"})
        proc_b = run_hook(self.db, ["sample"], extra_env={"IDEA_USAGE_INSTANCE_SALT": "test-salt-b"})
        ids_a = parse(proc_a)["office"]["documentIds"]
        ids_b = parse(proc_b)["office"]["documentIds"]
        self.assertEqual(ids_a, parse(run_hook(self.db, ["sample"], extra_env={"IDEA_USAGE_INSTANCE_SALT": "test-salt-a"}))["office"]["documentIds"])
        self.assertNotEqual(set(ids_a), set(ids_b))
        expected = sorted(
            hmac.new(salt, fid.encode(), hashlib.sha256).hexdigest()[:16]
            for fid in ("10", "11")
        )
        self.assertEqual(ids_a, expected)

    def test_day_setup_logins_workflows(self):
        proc = run_hook(self.db, ["day", DAY])
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        obj = parse(proc)
        self.assertEqual(obj["schema"], "idea-usage-day/1")
        self.assertEqual(obj["day"], DAY)
        self.assertEqual(obj["app"], "nextcloud")
        self.assertTrue(FORBIDDEN.isdisjoint(obj))
        self.assertEqual(obj["setup"]["admin"], {"total": 1, "beyondSeed": 0})
        self.assertEqual(obj["setup"]["teacher"], {"total": 1, "beyondSeed": 0})
        self.assertEqual(obj["setup"]["learner"], {"total": 3, "beyondSeed": 1})
        self.assertEqual(obj["setup"]["otherGroups"]["Grade 5"], {"total": 1, "beyondSeed": 0})
        self.assertNotIn("teachers", obj["setup"])
        self.assertNotIn("learners", obj["setup"])
        self.assertEqual(obj["logins"]["teacher"], {"total": 1, "beyondSeed": 0})
        self.assertEqual(obj["logins"]["learner"], {"total": 0, "beyondSeed": 0})
        self.assertEqual(obj["logins"]["admin"], {"total": 0, "beyondSeed": 0})
        self.assertNotIn("teachers", obj["logins"])
        self.assertNotIn("learners", obj["logins"])
        self.assertEqual(obj["office"]["byGroup"]["teacher"], 1)
        self.assertEqual(obj["office"]["byGroup"]["learner"], 1)
        self.assertNotIn("documentIds", obj["office"])
        self.assertEqual(obj["office"]["opens"], 2)
        self.assertEqual(obj["office"]["mime"]["text"], 1)
        self.assertEqual(obj["workflows"]["worksheetShares"], 1)
        self.assertEqual(obj["workflows"]["editShares"], 1)
        self.assertEqual(obj["workflows"]["fileDropLinks"], 1)
        self.assertEqual(obj["workflows"]["fileDropUploads"], 1)
        self.assertEqual(obj["workflows"]["schoolFilesShares"], 1)

    def test_no_usernames_or_addresses(self):
        obj = parse(run_hook(self.db, ["day", DAY]))
        blob = json.dumps(obj)
        self.assertNotIn("teacher1", blob)
        self.assertNotIn("learner1", blob)
        self.assertNotIn("learner2", blob)
        self.assertNotIn("thabo", blob)
        self.assertNotIn("127.0.0.1", blob)
        self.assertNotIn("worksheet.odt", blob)
        self.assertNotIn("sheet.ods", blob)

    def test_invalid_args(self):
        proc = run_hook(self.db, ["day", "nope"])
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, b"")


if __name__ == "__main__":
    unittest.main()
