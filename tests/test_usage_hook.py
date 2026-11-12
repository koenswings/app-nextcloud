"""Unit tests for hooks/usage.sh (idea#413, idea#431, idea#464). Run: python3 -m unittest tests.test_usage_hook"""
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
        permissions INTEGER, stime INTEGER, item_source INTEGER, file_target TEXT,
        uid_initiator TEXT
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
    conn.execute("INSERT INTO oc_share VALUES (1,1,'learners','teacher1',1,?,10,'/worksheet.odt',NULL)", (login_ts,))
    # edit share
    conn.execute("INSERT INTO oc_share VALUES (2,1,'teachers','admin',31,?,10,'/worksheet.odt',NULL)", (login_ts,))
    # file-drop link (create only)
    conn.execute("INSERT INTO oc_share VALUES (3,3,'','teacher1',4,?,20,'/drop',NULL)", (login_ts,))
    # school files share
    conn.execute("INSERT INTO oc_share VALUES (4,1,'learners','teacher1',1,?,30,'/notes.odt',NULL)", (login_ts,))
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
        self.assertEqual(obj["workflows"]["byGroup"]["worksheetShares"],
                         {"admin": 0, "teacher": 1, "learner": 0})
        self.assertEqual(obj["workflows"]["byGroup"]["editShares"],
                         {"admin": 1, "teacher": 0, "learner": 0})
        self.assertEqual(obj["workflows"]["byGroup"]["fileDropUploads"],
                         {"admin": 0, "teacher": 1, "learner": 0})
        self.assertEqual(obj["workflows"]["byGroup"]["schoolFilesShares"],
                         {"admin": 0, "teacher": 1, "learner": 0})
        self.assertNotIn("fileDropLinks", obj["workflows"]["byGroup"])
        self.assertNotIn("teachers", obj["workflows"]["byGroup"]["worksheetShares"])
        self.assertNotIn("learners", obj["workflows"]["byGroup"]["worksheetShares"])

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

    def test_share_by_group_prefers_initiator_and_filedrop_link_owner(self):
        """uid_initiator wins over uid_owner; file-drop uploads follow the link owner."""
        import datetime
        login_ts = int(datetime.datetime(2026, 11, 12, 10, 0, 0).timestamp())
        conn = sqlite3.connect(self.db)
        # Worksheet share: file owned by admin, created by teacher1.
        conn.execute(
            "INSERT INTO oc_share VALUES (5,1,'learners','admin',1,?,10,'/from-admin.odt','teacher1')",
            (login_ts,),
        )
        # Admin-owned file-drop folder plus one upload today.
        conn.execute("INSERT INTO oc_filecache VALUES (40, 1, 0, 'files/admin-drop', 1762940000, 1)")
        conn.execute(
            "INSERT INTO oc_filecache VALUES (41, 1, 40, 'files/admin-drop/hw.txt', ?, 1)",
            (login_ts,),
        )
        conn.execute(
            "INSERT INTO oc_share VALUES (6,3,'','admin',4,?,40,'/admin-drop','admin')",
            (login_ts,),
        )
        conn.commit()
        conn.close()
        obj = parse(run_hook(self.db, ["day", DAY]))
        wf = obj["workflows"]
        self.assertEqual(wf["worksheetShares"], 2)
        self.assertEqual(wf["byGroup"]["worksheetShares"],
                         {"admin": 0, "teacher": 2, "learner": 0})
        self.assertEqual(wf["fileDropLinks"], 2)
        self.assertEqual(wf["fileDropUploads"], 2)
        self.assertEqual(wf["byGroup"]["fileDropUploads"],
                         {"admin": 1, "teacher": 1, "learner": 0})
        blob = json.dumps(obj)
        self.assertNotIn("teacher1", blob)
        self.assertNotIn("from-admin.odt", blob)
        self.assertNotIn("admin-drop", blob)
        self.assertNotIn("hw.txt", blob)

    def test_empty_db_emits_zero_by_group(self):
        empty = os.path.join(self.tmp, "empty.sqlite")
        sqlite3.connect(empty).close()
        obj = parse(run_hook(empty, ["day", DAY]))
        self.assertEqual(obj["workflows"]["worksheetShares"], 0)
        self.assertEqual(obj["workflows"]["byGroup"]["worksheetShares"],
                         {"admin": 0, "teacher": 0, "learner": 0})
        self.assertEqual(obj["workflows"]["byGroup"]["fileDropUploads"],
                         {"admin": 0, "teacher": 0, "learner": 0})

    def test_apps_opened_omitted_when_counter_table_missing(self):
        obj = parse(run_hook(self.db, ["day", DAY]))
        self.assertNotIn("appsOpened", obj)
        self.assertNotIn("appsOpenedByGroup", obj)
        self.assertNotIn("documents", obj)
        self.assertNotIn("documentsCreated", obj)

    def test_apps_opened_empty_object_when_counter_installed_but_idle(self):
        conn = sqlite3.connect(self.db)
        conn.execute(
            "CREATE TABLE oc_idea_usage_apps_opened "
            "(day TEXT, grp TEXT, app_id TEXT, n INTEGER, PRIMARY KEY (day, grp, app_id))"
        )
        conn.commit()
        conn.close()
        obj = parse(run_hook(self.db, ["day", DAY]))
        self.assertEqual(obj["appsOpened"], {})
        self.assertEqual(obj["appsOpenedByGroup"], {})
        self.assertIsInstance(obj["appsOpened"], dict)

    def test_apps_opened_sums_by_app_and_group(self):
        conn = sqlite3.connect(self.db)
        conn.execute(
            "CREATE TABLE oc_idea_usage_apps_opened "
            "(day TEXT, grp TEXT, app_id TEXT, n INTEGER, PRIMARY KEY (day, grp, app_id))"
        )
        conn.executemany(
            "INSERT INTO oc_idea_usage_apps_opened VALUES (?,?,?,?)",
            [
                (DAY, "teacher", "files", 3),
                (DAY, "learner", "files", 2),
                (DAY, "admin", "files", 1),
                (DAY, "teacher", "text", 4),
                (DAY, "learner", "richdocuments", 1),
                ("2026-11-11", "teacher", "files", 99),  # other day
            ],
        )
        conn.commit()
        conn.close()
        obj = parse(run_hook(self.db, ["day", DAY]))
        self.assertEqual(obj["appsOpened"], {"files": 6, "text": 4, "richdocuments": 1})
        self.assertEqual(obj["appsOpenedByGroup"]["files"],
                         {"admin": 1, "teacher": 3, "learner": 2})
        self.assertEqual(obj["appsOpenedByGroup"]["text"],
                         {"admin": 0, "teacher": 4, "learner": 0})
        self.assertEqual(obj["appsOpenedByGroup"]["richdocuments"],
                         {"admin": 0, "teacher": 0, "learner": 1})
        blob = json.dumps(obj)
        self.assertNotIn("teacher1", blob)
        self.assertNotIn("thabo", blob)

    def test_documents_null_when_activity_disabled(self):
        """Activity off or missing → omit documents (null), never a zero count."""
        import datetime
        login_ts = int(datetime.datetime(2026, 11, 12, 10, 0, 0).timestamp())
        conn = sqlite3.connect(self.db)
        conn.execute(
            "CREATE TABLE oc_appconfig (appid TEXT, configkey TEXT, configvalue TEXT)"
        )
        conn.execute(
            "INSERT INTO oc_appconfig VALUES ('activity','enabled','no')"
        )
        conn.execute(
            "CREATE TABLE oc_activity "
            "(object_id INTEGER, user TEXT, timestamp INTEGER, app TEXT, type TEXT, subject TEXT)"
        )
        # A real created_self row must still be ignored while the app is off.
        conn.execute(
            "INSERT INTO oc_activity VALUES (10,'teacher1',?,'files','file_created','created_self')",
            (login_ts,),
        )
        conn.commit()
        conn.close()
        obj = parse(run_hook(self.db, ["day", DAY]))
        self.assertNotIn("documents", obj)
        self.assertNotIn("documentsCreated", obj)

    def test_documents_null_when_activity_table_missing(self):
        conn = sqlite3.connect(self.db)
        conn.execute(
            "CREATE TABLE oc_appconfig (appid TEXT, configkey TEXT, configvalue TEXT)"
        )
        conn.execute(
            "INSERT INTO oc_appconfig VALUES ('activity','enabled','yes')"
        )
        conn.commit()
        conn.close()
        obj = parse(run_hook(self.db, ["day", DAY]))
        self.assertNotIn("documents", obj)

    def test_documents_created_from_activity_office_mimes(self):
        import datetime
        login_ts = int(datetime.datetime(2026, 11, 12, 10, 0, 0).timestamp())
        other_ts = int(datetime.datetime(2026, 11, 10, 10, 0, 0).timestamp())
        conn = sqlite3.connect(self.db)
        conn.execute(
            "CREATE TABLE oc_appconfig (appid TEXT, configkey TEXT, configvalue TEXT)"
        )
        conn.execute(
            "INSERT INTO oc_appconfig VALUES ('activity','enabled','yes')"
        )
        conn.execute(
            "CREATE TABLE oc_activity "
            "(object_id INTEGER, user TEXT, timestamp INTEGER, app TEXT, type TEXT, subject TEXT)"
        )
        # teacher created an office text doc today (file 10 already in filecache as odt)
        conn.execute(
            "INSERT INTO oc_activity VALUES (10,'teacher1',?,'files','file_created','created_self')",
            (login_ts,),
        )
        # duplicate row for the same object_id must count once
        conn.execute(
            "INSERT INTO oc_activity VALUES (10,'teacher1',?,'files','file_created','created_self')",
            (login_ts,),
        )
        # learner created a sheet (file 11)
        conn.execute(
            "INSERT INTO oc_activity VALUES (11,'learner1',?,'files','file_created','created_self')",
            (login_ts,),
        )
        # admin who is also... just admin, same odt mime on a new file
        conn.execute("INSERT INTO oc_filecache VALUES (12, 1, 0, 'files/admin-notes.odt', ?, 1)", (login_ts,))
        conn.execute(
            "INSERT INTO oc_activity VALUES (12,'admin',?,'files','file_created','created_self')",
            (login_ts,),
        )
        # created_public (anonymous File drop) must be left out, even if office mime
        conn.execute("INSERT INTO oc_filecache VALUES (13, 1, 20, 'files/drop/public.odt', ?, 1)", (login_ts,))
        conn.execute(
            "INSERT INTO oc_activity VALUES (13,'',?,'files','file_created','created_public')",
            (login_ts,),
        )
        # non-office mime (reuse drop upload.txt = file 21, mimetype 1 is odt in fixture...
        # file 21 is files/drop/upload.txt with mimetype 1 (odt) in the base fixture.
        # Add a real non-office type instead.
        conn.execute("INSERT INTO oc_mimetypes VALUES (3, 'text/plain')")
        conn.execute("INSERT INTO oc_filecache VALUES (14, 1, 0, 'files/readme.txt', ?, 3)", (login_ts,))
        conn.execute(
            "INSERT INTO oc_activity VALUES (14,'teacher1',?,'files','file_created','created_self')",
            (login_ts,),
        )
        # other day
        conn.execute(
            "INSERT INTO oc_activity VALUES (10,'teacher1',?,'files','file_created','created_self')",
            (other_ts,),
        )
        conn.commit()
        conn.close()
        obj = parse(run_hook(self.db, ["day", DAY]))
        self.assertEqual(obj["documents"]["created"], 3)
        self.assertEqual(obj["documents"]["byGroup"],
                         {"admin": 1, "teacher": 1, "learner": 1})
        blob = json.dumps(obj)
        self.assertNotIn("teacher1", blob)
        self.assertNotIn("admin-notes.odt", blob)
        self.assertNotIn("readme.txt", blob)
        self.assertEqual(set(obj["documents"].keys()), {"created", "byGroup"})
        self.assertNotIn("files/", blob)

    def test_documents_zero_when_activity_on_but_nothing_created(self):
        conn = sqlite3.connect(self.db)
        conn.execute(
            "CREATE TABLE oc_appconfig (appid TEXT, configkey TEXT, configvalue TEXT)"
        )
        conn.execute(
            "INSERT INTO oc_appconfig VALUES ('activity','enabled','yes')"
        )
        conn.execute(
            "CREATE TABLE oc_activity "
            "(object_id INTEGER, user TEXT, timestamp INTEGER, app TEXT, type TEXT, subject TEXT)"
        )
        conn.commit()
        conn.close()
        obj = parse(run_hook(self.db, ["day", DAY]))
        self.assertEqual(obj["documents"], {"created": 0, "byGroup": {"admin": 0, "teacher": 0, "learner": 0}})




if __name__ == "__main__":
    unittest.main()
