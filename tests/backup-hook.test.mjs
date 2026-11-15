/**
 * idea#403 live backup (agent-engine-dev#404): x-app.backup in compose.yaml, the dump/clean
 * steps run in nextcloud-db, and before-starting/00-idea-restore.sh. Run: node --test tests/
 */
import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync, statSync } from 'node:fs'
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
  assert.match(compose, /test: \["CMD-SHELL", "\[ ! -e \/var\/lib\/mysql\/\.idea-import-pending \] && healthcheck\.sh --connect --innodb_initialized"\]/)
  assert.match(compose, /- MARIADB_AUTO_UPGRADE=1\n/, 'healthcheck user on existing data dirs')
  assert.doesNotMatch(compose, /mariadb-admin|healthcheck.*PASS|--password/, 'no credential-less ping, no password in compose')
  assert.match(compose, /depends_on:\n      nextcloud-db:\n        condition: service_healthy/)
  assert.doesNotMatch(compose, /^\s+restart: (?!no)/m, 'restart: no stays on every service')
})

it('dump: writes nextcloud.sql + id, password only via MYSQL_PWD, never printed', () => {
  const r = run(DUMP)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(readdirSync(out).sort(), ['00-idea-import-begin.sh', 'nextcloud.sql', 'nextcloud.sql.id', 'zz-idea-import-end.sh'])
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

it('dump: import markers run around nextcloud.sql in initdb glob order; a broken import leaves .idea-import-pending', () => {
  assert.equal(run(DUMP).status, 0)
  // MariaDB's docker_process_init_files: for f in /docker-entrypoint-initdb.d/*  (C sort; *.id is ignored)
  const order = spawnSync('sh', ['-c', 'cd "$1" && for f in *; do echo "$f"; done', 'sh', out], { encoding: 'utf8', env: { LC_ALL: 'C', PATH: process.env.PATH } }).stdout.trim().split('\n')
  assert.deepEqual(order, ['00-idea-import-begin.sh', 'nextcloud.sql', 'nextcloud.sql.id', 'zz-idea-import-end.sh'])
  const datadir = join(dir, 'datadir'); mkdirSync(datadir)
  const src = (f) => spawnSync('sh', ['-c', '. "$1"', 'sh', join(out, f)], { encoding: 'utf8', env: { PATH: process.env.PATH, DATADIR: datadir } })
  const pending = join(datadir, '.idea-import-pending')
  assert.equal(src('00-idea-import-begin.sh').status, 0); assert.ok(existsSync(pending), 'begin marks pending')
  // Import fails half-way: the entrypoint stops, zz-idea-import-end.sh never runs, the marker stays.
  assert.ok(existsSync(pending))
  assert.equal(src('zz-idea-import-end.sh').status, 0); assert.ok(!existsSync(pending), 'end clears pending')
  // Not executable: the entrypoint sources them (DATADIR in scope).
  for (const f of ['00-idea-import-begin.sh', 'zz-idea-import-end.sh']) assert.equal(statSync(join(out, f)).mode & 0o111, 0, f)
  // clean removes the markers with the dump.
  assert.equal(run(CLEAN).status, 0); assert.deepEqual(readdirSync(out), [])
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

const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (f, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) return false; await sleep(50) } return true }

it('restore hook: quick maintenance off, then a detached worker scans once Apache is up; once per dump id', async () => {
  const state = join(dir, 'occ.json'), data = join(dir, 'ncdata'), status = join(dir, 'status.json')
  mkdirSync(data)
  writeFileSync(state, JSON.stringify({ calls: [] }))
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\ncat "${status}" 2>/dev/null || exit 7\n`); chmodSync(join(bin, 'curl'), 0o755)
  const env = { PATH: `${bin}:${process.env.PATH}`, OCC: FAKE_OCC, FAKE_OCC_STATE: state, IDEA_RESTORE_DB_DIR: out,
    IDEA_RESTORE_DATA: data, IDEA_RESTORE_INTERVAL: '0.1' }
  const calls = () => JSON.parse(readFileSync(state, 'utf8')).calls
  const go = () => { const t = Date.now(); const r = spawnSync(RESTORE, [], { encoding: 'utf8', env, timeout: 5000 }); assert.equal(r.status, 0, r.stdout + r.stderr); assert.ok(Date.now() - t < 3000, 'hook returns at once'); return r.stdout }
  const marker = join(data, '.idea-restore-id'), running = join(data, '.idea-restore-scan.running'), log = join(data, '.idea-restore-scan.log')

  go(); assert.deepEqual(calls(), [], 'no dump: nothing')
  assert.equal(run(DUMP).status, 0)
  const id = readFileSync(join(out, 'nextcloud.sql.id'), 'utf8')
  // Apache not up yet: the hook turns maintenance off and returns; the worker waits.
  assert.match(go(), /files:scan --all starts once Apache is up/)
  assert.deepEqual(calls(), [['maintenance:mode', '--off']])
  assert.ok(existsSync(running))
  await sleep(400)
  assert.deepEqual(calls(), [['maintenance:mode', '--off']], 'no scan before status.php answers')
  writeFileSync(status, '{"installed":true,"maintenance":false,"needsDbUpgrade":false}')
  assert.ok(await until(() => existsSync(marker)), 'worker wrote the done marker')
  assert.deepEqual(calls(), [['maintenance:mode', '--off'], ['files:scan', '--all']])
  assert.equal(readFileSync(marker, 'utf8'), id)
  assert.ok(await until(() => !existsSync(running)))
  assert.match(readFileSync(log, 'utf8'), /Apache up after [\d.]+s: occ files:scan --all[\s\S]*files:scan --all done/)
  go(); await sleep(300); assert.equal(calls().length, 2, 'same id: nothing again')

  // New dump id, failing scan: no marker, retried on the next start.
  assert.equal(run(DUMP).status, 0)
  env.FAKE_OCC_SCAN_FAIL = '1'; go()
  assert.ok(await until(() => !existsSync(running)))
  assert.equal(readFileSync(marker, 'utf8'), id, 'old marker kept')
  assert.match(readFileSync(log, 'utf8'), /files:scan --all failed \(retried on next start\)/)
  // A crashed worker leaves .running behind: the next start clears it and runs again.
  writeFileSync(running, 'stale\n')
  env.FAKE_OCC_SCAN_FAIL = '0'; go()
  assert.ok(await until(() => readFileSync(marker, 'utf8') === readFileSync(join(out, 'nextcloud.sql.id'), 'utf8')))
  assert.ok(await until(() => !existsSync(running)))
})

it('restore hook: worker gives up after IDEA_RESTORE_WAIT without a scan or marker', async () => {
  const state = join(dir, 'occ.json'), data = join(dir, 'ncdata'); mkdirSync(data)
  writeFileSync(state, JSON.stringify({ calls: [] }))
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexit 7\n'); chmodSync(join(bin, 'curl'), 0o755)
  assert.equal(run(DUMP).status, 0)
  const env = { PATH: `${bin}:${process.env.PATH}`, OCC: FAKE_OCC, FAKE_OCC_STATE: state, IDEA_RESTORE_DB_DIR: out,
    IDEA_RESTORE_DATA: data, IDEA_RESTORE_INTERVAL: '1', IDEA_RESTORE_WAIT: '1' }
  assert.equal(spawnSync(RESTORE, [], { env }).status, 0)
  assert.ok(await until(() => !existsSync(join(data, '.idea-restore-scan.running'))))
  assert.ok(!existsSync(join(data, '.idea-restore-id')))
  assert.match(readFileSync(join(data, '.idea-restore-scan.log'), 'utf8'), /gave up after 1s/)
  assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')).calls, [['maintenance:mode', '--off']])
})

