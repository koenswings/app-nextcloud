/**
 * idea#403 live backup (agent-engine-dev#404): x-app.backup in compose.yaml, the dump/clean
 * steps run in nextcloud-db, and before-starting/00-idea-restore.sh. Run: node --test tests/
 */
import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DUMP = join(root, 'hooks/backup-db-dump.sh')
const CLEAN = join(root, 'hooks/backup-db-clean.sh')
const RESTORE = join(root, 'docker-entrypoint-hooks.d/before-starting/00-idea-restore.sh')
const FAKE_OCC = join(root, 'tests/fake-occ-restore.mjs')
const compose = readFileSync(join(root, 'compose.yaml'), 'utf8')
const SECRET = 'not-a-real-pass-7Q'
let dir, bin, out

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idea-nc-backup-'))
  bin = join(dir, 'bin'); out = join(dir, 'initdb'); mkdirSync(bin); mkdirSync(out)
  // Fake mariadb-dump: refuses a password on argv, needs MYSQL_PWD, logs argv.
  writeFileSync(join(bin, 'mariadb-dump'), `#!/bin/sh
printf '%s\\n' "$*" > "${dir}/dump-argv"
case "$*" in *${SECRET}*) echo "password on argv" >&2; exit 9;; esac
[ "$MYSQL_PWD" = "${SECRET}" ] || { echo "no MYSQL_PWD" >&2; exit 8; }
echo "-- MariaDB dump"
echo 'CREATE TABLE \`oc_filecache\` (fileid bigint);'
[ "$FAKE_DUMP" = truncated ] && exit 0
[ "$FAKE_DUMP" = fail ] && { echo "Got error: 2002" >&2; exit 2; }
echo "-- Dump completed on 2026-11-14 22:00:00"
`)
  chmodSync(join(bin, 'mariadb-dump'), 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const run = (script, env = {}) => spawnSync(script, [], { encoding: 'utf8',
  env: { PATH: `${bin}:${process.env.PATH}`, IDEA_BACKUP_DB_DIR: out, MYSQL_ROOT_PASSWORD: SECRET, MYSQL_DATABASE: 'nextcloud', ...env } })

it('compose: hook method, ordered pre/post lists, hookExclude data/db, mounts, db healthcheck, depends_on', () => {
  assert.match(compose, /^  backup:\n    method: hook\n    fallback: stop\n    hookTimeout: 600/m)
  assert.match(compose, /preHook:\n      - service: nextcloud-app\n        user: "33"\n        command: \[php, \/var\/www\/html\/occ, maintenance:mode, --on\]\n      - service: nextcloud-db\n        command: \[\/idea\/backup\/db-dump\.sh\]/)
  assert.match(compose, /postHook:\n      - service: nextcloud-app\n        user: "33"\n        command: \[php, \/var\/www\/html\/occ, maintenance:mode, --off\]\n      - service: nextcloud-db\n        command: \[\/idea\/backup\/db-clean\.sh\]/)
  assert.match(compose, /hookExclude:\n      - data\/db /)
  assert.match(compose, /- \.\/data\/backup\/db:\/docker-entrypoint-initdb\.d\n/)
  assert.match(compose, /- \.\/hooks\/backup-db-dump\.sh:\/idea\/backup\/db-dump\.sh:ro/)
  assert.match(compose, /- \.\/hooks\/backup-db-clean\.sh:\/idea\/backup\/db-clean\.sh:ro/)
  assert.match(compose, /- \.\/data\/backup\/db:\/idea-backup-db:ro/)
  assert.match(compose, /test: \["CMD", "mariadb-admin", "ping", "-h", "127\.0\.0\.1", "--silent"\]/)
  assert.match(compose, /depends_on:\n      nextcloud-db:\n        condition: service_healthy/)
  assert.doesNotMatch(compose, /^\s+restart: (?!no)/m, 'restart: no stays on every service')
})

it('dump: writes nextcloud.sql + id, password only via MYSQL_PWD, never printed', () => {
  const r = run(DUMP)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(readdirSync(out).sort(), ['nextcloud.sql', 'nextcloud.sql.id'])
  assert.match(readFileSync(join(out, 'nextcloud.sql'), 'utf8'), /-- Dump completed on/)
  assert.match(readFileSync(join(out, 'nextcloud.sql.id'), 'utf8'), /^\d{8}T\d{6}Z-[0-9a-f-]{36}\n$/)
  const argv = readFileSync(join(dir, 'dump-argv'), 'utf8')
  assert.match(argv, /--single-transaction/); assert.match(argv, /-uroot/); assert.match(argv, / nextcloud\n$/)
  assert.ok(!(r.stdout + r.stderr).includes(SECRET))
})

it('dump: a failed or truncated dump exits non-zero and leaves no nextcloud.sql (old dump removed too)', () => {
  for (const mode of ['fail', 'truncated']) {
    writeFileSync(join(out, 'nextcloud.sql'), 'old'); writeFileSync(join(out, 'nextcloud.sql.id'), 'old\n')
    const r = run(DUMP, { FAKE_DUMP: mode })
    assert.notEqual(r.status, 0, mode)
    assert.deepEqual(readdirSync(out), [], mode)
    assert.ok(!(r.stdout + r.stderr).includes(SECRET))
  }
})

it('dump: missing password or dump folder fails closed', () => {
  assert.equal(run(DUMP, { MYSQL_ROOT_PASSWORD: '' }).status, 1)
  assert.equal(run(DUMP, { IDEA_BACKUP_DB_DIR: join(dir, 'nope') }).status, 1)
})

it('clean: removes only the dump files, idempotent', () => {
  assert.equal(run(DUMP).status, 0)
  writeFileSync(join(out, 'keep.txt'), 'x')
  assert.equal(run(CLEAN).status, 0)
  assert.deepEqual(readdirSync(out), ['keep.txt'])
  assert.equal(run(CLEAN).status, 0)
  assert.equal(run(CLEAN, { IDEA_BACKUP_DB_DIR: join(dir, 'nope') }).status, 0)
})

it('restore hook: once per dump id, maintenance off then files:scan --all; no-op without a dump', () => {
  const state = join(dir, 'occ.json'), rec = join(dir, 'restore-id')
  writeFileSync(state, JSON.stringify({ installed: true, calls: [], system: {} }))
  const env = { PATH: process.env.PATH, OCC: FAKE_OCC, FAKE_OCC_STATE: state, IDEA_RESTORE_DB_DIR: out, IDEA_RESTORE_STATE: rec }
  const go = () => { const r = spawnSync(RESTORE, [], { encoding: 'utf8', env }); assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout }
  go(); assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')).calls, [], 'no dump: nothing')
  assert.equal(run(DUMP).status, 0)
  assert.match(go(), /restored from hook backup/)
  const calls = JSON.parse(readFileSync(state, 'utf8')).calls
  assert.deepEqual(calls.slice(0, 2), [['maintenance:mode', '--off'], ['files:scan', '--all']])
  assert.equal(readFileSync(rec, 'utf8'), readFileSync(join(out, 'nextcloud.sql.id'), 'utf8'))
  go(); assert.equal(JSON.parse(readFileSync(state, 'utf8')).calls.length, calls.length, 'same id: not again')
  // A new dump id with a failing scan is not recorded, so the next start tries again.
  assert.equal(run(DUMP).status, 0)
  env.FAKE_OCC_SCAN_FAIL = '1'; assert.match(go(), /files:scan --all failed/)
  assert.notEqual(readFileSync(rec, 'utf8'), readFileSync(join(out, 'nextcloud.sql.id'), 'utf8'))
  env.FAKE_OCC_SCAN_FAIL = '0'; go()
  assert.equal(readFileSync(rec, 'utf8'), readFileSync(join(out, 'nextcloud.sql.id'), 'utf8'))
})
