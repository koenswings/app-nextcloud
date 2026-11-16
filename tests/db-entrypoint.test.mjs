/**
 * agent-engine-dev#468 (app-nextcloud#42): nextcloud-db entrypoint wrapper hooks/db-entrypoint.sh
 * (longer temporary-server wait, retry-safe restore import) and hooks/db-healthcheck.sh (Nextcloud
 * schema required once expected), against tests/fake-mariadb-entrypoint.sh. The restore dump and
 * its import markers are written by the real hooks/backup-db-dump.sh. Run: node --test
 */
import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const WRAP = join(root, 'hooks/db-entrypoint.sh')
const HEALTH = join(root, 'hooks/db-healthcheck.sh')
const DUMP = join(root, 'hooks/backup-db-dump.sh')
const FAKE = join(root, 'tests/fake-mariadb-entrypoint.sh')
const SECRET = 'not-a-real-pass-468'
let dir, bin, data, initdb, quar, state, flog

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idea-nc-dbentry-'))
  bin = join(dir, 'bin'); data = join(dir, 'db'); initdb = join(dir, 'initdb'); quar = join(dir, 'quarantine'); state = join(dir, 'state')
  for (const d of [bin, data, initdb, state]) mkdirSync(d)
  flog = join(state, 'log')
  writeFileSync(join(bin, 'mariadbd'), '#!/bin/sh\necho "MARIADBD $*"\n'); chmodSync(join(bin, 'mariadbd'), 0o755)
  writeFileSync(join(bin, 'mariadb-dump'), `#!/bin/sh
echo "-- MariaDB dump"
[ "$FAKE_NO_APPCONFIG" = 1 ] || echo 'CREATE TABLE \`oc_appconfig\` (appid varchar(32));'
echo 'CREATE TABLE \`oc_filecache\` (fileid bigint);'
echo "-- Dump completed on 2026-11-16 07:00:00"
`); chmodSync(join(bin, 'mariadb-dump'), 0o755)
  writeFileSync(join(bin, 'fake-image-healthcheck'), '#!/bin/sh\n[ "$FAKE_HC" = down ] && exit 1\nexit 0\n'); chmodSync(join(bin, 'fake-image-healthcheck'), 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const env = (extra = {}) => ({ PATH: `${bin}:${process.env.PATH}`, FAKE_DATADIR: data, FAKE_INITDB: initdb, FAKE_STATE: state,
  FAKE_LOG: flog, IDEA_DB_STOCK_ENTRYPOINT: FAKE, IDEA_DB_QUARANTINE_DIR: quar, IDEA_DB_INITDB_DIR: initdb,
  MYSQL_DATABASE: 'nextcloud', MYSQL_ROOT_PASSWORD: SECRET, ...extra })
const start = (extra = {}, script = WRAP) => {
  rmSync(join(state, 'probes'), { force: true })
  return spawnSync('bash', [script, '--transaction-isolation=READ-COMMITTED', '--binlog-format=ROW'], { encoding: 'utf8', env: env(extra) })
}
const writeDump = (extra = {}) => {
  const r = spawnSync(DUMP, [], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, IDEA_BACKUP_DB_DIR: initdb, MYSQL_ROOT_PASSWORD: SECRET, MYSQL_DATABASE: 'nextcloud', ...extra } })
  assert.equal(r.status, 0, r.stderr)
}
const health = (extra = {}) => spawnSync('bash', [HEALTH], { encoding: 'utf8',
  env: { PATH: `${bin}:${process.env.PATH}`, IDEA_DB_DATADIR: data, IDEA_DB_IMAGE_HEALTHCHECK: 'fake-image-healthcheck', MYSQL_DATABASE: 'nextcloud', ...extra } })
const log = () => (existsSync(flog) ? readFileSync(flog, 'utf8') : '')
const quarantined = () => (existsSync(quar) ? readdirSync(quar).sort() : [])
const out = (r) => r.stdout + r.stderr

it('fresh install (no dump): stock init, no restore marker, no quarantine, mariadbd started', () => {
  const r = start()
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /^MARIADBD --transaction-isolation=READ-COMMITTED --binlog-format=ROW$/m)
  assert.match(r.stderr, /temporary server start wait: 300 tries \(stock 30\)/)
  assert.match(log(), /^init\ntemp-start\ntemp-stop\n$/)
  assert.ok(existsSync(join(data, 'mysql')))
  for (const f of ['.idea-restore-pending', '.idea-schema-expected']) assert.ok(!existsSync(join(data, f)), f)
  assert.deepEqual(quarantined(), [])
})

it('#468 repro: the stock entrypoint gives up after 31 probes on a slow temporary server', () => {
  writeDump()
  const r = spawnSync('bash', [FAKE, '--x'], { encoding: 'utf8', env: env({ FAKE_READY_AT: '40' }) })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /Unable to start server\./)
  assert.equal(readFileSync(join(state, 'probes'), 'utf8').trim(), '31')
  assert.ok(existsSync(join(data, 'mysql')) && !existsSync(join(data, 'nextcloud')), 'initialised, never imported')
})

it('restore on a slow temporary server: the longer wait imports the dump, marker cleared, schema expected', () => {
  writeDump()
  const r = start({ FAKE_READY_AT: '40' })
  assert.equal(r.status, 0, out(r))
  assert.equal(readFileSync(join(state, 'probes'), 'utf8').trim(), '40')
  assert.match(r.stderr, /restore: empty data dir and .*nextcloud\.sql present: import pending/)
  assert.match(r.stderr, /restore: import done, nextcloud\.oc_appconfig present; \.idea-restore-pending cleared/)
  assert.ok(existsSync(join(data, 'nextcloud/oc_appconfig.frm')))
  assert.ok(!existsSync(join(data, '.idea-restore-pending')))
  assert.ok(!existsSync(join(data, '.idea-import-pending')), 'dump end marker ran')
  assert.ok(existsSync(join(data, '.idea-schema-expected')))
  assert.match(log(), /init\ntemp-start\nimport\nschema-query nextcloud\ntemp-stop\n/)
  assert.match(r.stdout, /^MARIADBD /m)
  assert.deepEqual(quarantined(), [])
  assert.ok(!out(r).includes(SECRET), 'no password printed')
})

it('retry: a start that timed out leaves the marker; the next start moves the datadir to a new quarantine folder and imports', () => {
  writeDump()
  const r1 = start({ FAKE_READY_AT: '40', IDEA_DB_START_WAIT: '5' })
  assert.equal(r1.status, 1)
  assert.match(r1.stderr, /Unable to start server\./)
  assert.ok(existsSync(join(data, '.idea-restore-pending')) && existsSync(join(data, 'mysql')))
  assert.ok(!existsSync(join(data, 'nextcloud')))
  // a plain restart of the stock entrypoint would skip initdb here (datadir not empty)
  const r2 = start()
  assert.equal(r2.status, 0, out(r2))
  assert.match(r2.stderr, /the last import never completed; moved the half-initialised data dir into .*\/db-\d{8}T\d{6}Z-\d+ \(kept, not deleted\)/)
  const q = quarantined()
  assert.equal(q.length, 1)
  assert.deepEqual(readdirSync(join(quar, q[0])).sort(), ['.idea-restore-pending', 'mysql'])
  assert.ok(existsSync(join(data, 'nextcloud/oc_appconfig.frm')))
  assert.ok(!existsSync(join(data, '.idea-restore-pending')))
  assert.ok(existsSync(join(data, '.idea-schema-expected')))
})

it('retry: a broken import (old .idea-import-pending marker only) is also moved aside and re-imported', () => {
  writeDump()
  mkdirSync(join(data, 'mysql')); writeFileSync(join(data, '.idea-import-pending'), ''); mkdirSync(join(data, 'nextcloud'))
  writeFileSync(join(data, 'nextcloud/oc_filecache.frm'), '')
  const r = start()
  assert.equal(r.status, 0, out(r))
  const q = quarantined()
  assert.equal(q.length, 1)
  assert.deepEqual(readdirSync(join(quar, q[0])).sort(), ['.idea-import-pending', 'mysql', 'nextcloud'])
  assert.ok(existsSync(join(data, 'nextcloud/oc_appconfig.frm')))
})

it('every retry uses a NEW quarantine folder; nothing is deleted', () => {
  writeDump()
  for (let n = 1; n <= 2; n++) {
    const r = start({ FAKE_IMPORT: 'fail' })
    assert.equal(r.status, 1, out(r))
    assert.ok(existsSync(join(data, '.idea-restore-pending')))
  }
  assert.equal(quarantined().length, 1)
  const r = start()
  assert.equal(r.status, 0, out(r))
  assert.equal(quarantined().length, 2)
  assert.ok(existsSync(join(data, 'nextcloud/oc_appconfig.frm')))
})

it('import without the Nextcloud schema: exit 1, marker kept (next start retries), never healthy', () => {
  writeDump({ FAKE_NO_APPCONFIG: '1' })
  const r = start()
  assert.equal(r.status, 1)
  assert.match(r.stderr, /nextcloud\.oc_appconfig missing after the import; \.idea-restore-pending kept/)
  assert.match(log(), /schema-query nextcloud\ntemp-stop\n$/, 'temporary server stopped before the exit')
  assert.ok(existsSync(join(data, '.idea-restore-pending')))
  assert.equal(health().status, 1)
})

it('marker without a dump: nothing moved (nothing to re-import), stays unhealthy', () => {
  mkdirSync(join(data, 'mysql')); writeFileSync(join(data, '.idea-restore-pending'), '')
  const r = start()
  assert.equal(r.status, 0, out(r))
  assert.match(r.stderr, /import marker present but no dump .*data dir left as is/)
  assert.deepEqual(quarantined(), [])
  assert.ok(existsSync(join(data, 'mysql')))
  assert.equal(health().status, 1)
})

it('normal start after a restore (datadir initialised, leftover dump, no marker): no init, no move', () => {
  writeDump()
  mkdirSync(join(data, 'mysql')); mkdirSync(join(data, 'nextcloud')); writeFileSync(join(data, 'nextcloud/oc_appconfig.frm'), '')
  const r = start()
  assert.equal(r.status, 0, out(r))
  assert.equal(log(), '')
  assert.deepEqual(quarantined(), [])
  assert.ok(!existsSync(join(data, '.idea-restore-pending')))
})

it('stock entrypoint without the {30..0} loop text: stock loop kept, restore retry still on', () => {
  const alt = join(dir, 'alt-entrypoint.sh')
  writeFileSync(alt, readFileSync(FAKE, 'utf8').replace(/^\tfor i in \{30\.\.0\}/m, '\tfor i in {60..0}'))
  writeDump()
  const r = start({ IDEA_DB_STOCK_ENTRYPOINT: alt, FAKE_READY_AT: '40' })
  assert.equal(r.status, 0, out(r))
  assert.match(r.stderr, /temporary server start wait: stock loop kept/)
  assert.ok(!existsSync(join(data, '.idea-restore-pending')))
})

it('stock entrypoint missing a needed function: runs it unchanged', () => {
  const alt = join(dir, 'alt-entrypoint.sh')
  writeFileSync(alt, readFileSync(FAKE, 'utf8').replace('docker_temp_server_stop() {', 'renamed_stop() {').replace(/docker_temp_server_stop$/m, 'renamed_stop'))
  const r = start({ IDEA_DB_STOCK_ENTRYPOINT: alt })
  assert.match(r.stderr, /stock entrypoint has no docker_temp_server_stop\(\); running it unchanged/)
})

it('non-mariadbd command: handed to the stock entrypoint as is', () => {
  const r = spawnSync('bash', [WRAP, 'echo', 'hi'], { encoding: 'utf8', env: env() })
  assert.equal(r.status, 0, out(r))
  assert.equal(r.stdout.trim(), 'hi')
  assert.equal(log(), '')
})

it('healthcheck: fresh install without the schema is healthy (no deadlock with depends_on service_healthy)', () => {
  mkdirSync(join(data, 'mysql'))
  const r = health()
  assert.equal(r.status, 0, out(r))
  assert.ok(!existsSync(join(data, '.idea-schema-expected')))
})

it('healthcheck: schema seen once -> expected from then on; missing schema later -> unhealthy', () => {
  mkdirSync(join(data, 'nextcloud'), { recursive: true }); writeFileSync(join(data, 'nextcloud/oc_appconfig.frm'), '')
  assert.equal(health().status, 0)
  assert.ok(existsSync(join(data, '.idea-schema-expected')))
  rmSync(join(data, 'nextcloud'), { recursive: true })
  const r = health()
  assert.equal(r.status, 1)
  assert.match(r.stdout, /Nextcloud schema expected but nextcloud\/oc_appconfig is missing/)
})

it('healthcheck: unhealthy on either import marker or when the image check fails', () => {
  mkdirSync(join(data, 'nextcloud')); writeFileSync(join(data, 'nextcloud/oc_appconfig.frm'), '')
  writeFileSync(join(data, '.idea-restore-pending'), '')
  assert.equal(health().status, 1)
  rmSync(join(data, '.idea-restore-pending')); writeFileSync(join(data, '.idea-import-pending'), '')
  assert.equal(health().status, 1)
  rmSync(join(data, '.idea-import-pending'))
  assert.equal(health({ FAKE_HC: 'down' }).status, 1)
  assert.equal(health().status, 0)
})

it('real image entrypoint has what the wrapper needs (when IDEA_MARIADB_ENTRYPOINT is set)', { skip: !process.env.IDEA_MARIADB_ENTRYPOINT || !existsSync(process.env.IDEA_MARIADB_ENTRYPOINT) }, () => {
  const r = spawnSync('bash', ['-c', `. "$1"; for f in _main docker_setup_env docker_create_db_directories docker_temp_server_start docker_temp_server_stop docker_process_sql mysql_error; do declare -F "$f" >/dev/null || { echo "missing $f"; exit 1; }; done; declare -f docker_temp_server_start | grep -cF '{30..0}'`, 'x', process.env.IDEA_MARIADB_ENTRYPOINT], { encoding: 'utf8' })
  assert.equal(r.status, 0, out(r))
  assert.equal(r.stdout.trim(), '1')
})

const compose = readFileSync(join(root, 'compose.yaml'), 'utf8')
const VER = /^  version: "([^"]+)"$/m.exec(compose)[1]
const svcBlock = (name) => {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:\\n|(?![\\s\\S]))`, 'm').exec(compose.slice(compose.indexOf('\nservices:\n')))
  assert.ok(m, `service ${name}`)
  return m[1]
}

it('compose: nextcloud-db wrapper entrypoint, schema healthcheck, restart on-failure:3, mounts, wait env', () => {
  const db = svcBlock('nextcloud-db')
  assert.match(db, /^    entrypoint: \["bash", "\/idea\/db\/entrypoint\.sh"\]$/m)
  assert.match(db, /^    command: --transaction-isolation=READ-COMMITTED/m, 'image command kept (wrapper prepends mariadbd)')
  assert.match(db, /^    restart: on-failure:3$/m)
  assert.match(db, /^      test: \["CMD", "bash", "\/idea\/db\/healthcheck\.sh"\]$/m)
  assert.match(db, /^      start_period: 900s$/m)
  assert.match(db, /^      - \.\/hooks\/db-entrypoint\.sh:\/idea\/db\/entrypoint\.sh:ro$/m)
  assert.match(db, /^      - \.\/hooks\/db-healthcheck\.sh:\/idea\/db\/healthcheck\.sh:ro$/m)
  assert.match(db, /^      - \.\/data\/db-quarantine:\/idea\/db-quarantine$/m)
  assert.match(db, /^      - \.\/data\/db:\/var\/lib\/mysql$/m)
  assert.match(db, /^      - \.\/data\/backup\/db:\/docker-entrypoint-initdb\.d$/m)
  assert.match(db, /^      - IDEA_DB_START_WAIT=300$/m)
  assert.match(db, /^      - MARIADB_AUTO_UPGRADE=1$/m)
  for (const s of ['nextcloud-app', 'code']) assert.match(svcBlock(s), /^    restart: no$/m, `${s} keeps restart: no`)
  assert.match(svcBlock('nextcloud-app'), /depends_on:\n      nextcloud-db:\n        condition: service_healthy/)
})

it('compose: every service labelled x-app-version = x-app.version; no host port below 3000; only ./ binds', () => {
  const names = [...compose.slice(compose.indexOf('\nservices:\n')).matchAll(/^  ([a-z][a-z-]*):$/gm)].map((m) => m[1])
  assert.deepEqual(names, ['nextcloud-app', 'nextcloud-db', 'code'])
  for (const n of names) assert.match(svcBlock(n), new RegExp(`^      x-app-version: "${VER.replace(/\./g, '\\.')}"$`, 'm'), n)
  for (const n of names) {
    const b = svcBlock(n)
    for (const p of b.match(/^    ports:\n((?:      - .*\n)+)/m)?.[1].trim().split('\n') ?? []) {
      const host = p.replace(/^- /, '').split(':')[0]
      assert.ok(host === '${port}' || Number(host) >= 3000, `${n} port ${p}`)
    }
    const vols = b.match(/^    volumes:\n((?:      (?:- .*|#.*)\n)+)/m)?.[1].split('\n').filter((l) => l.trim().startsWith('- ')) ?? []
    for (const v of vols) assert.match(v.trim(), /^- \.\//, `${n}: ${v.trim()} must be a ./ bind`)
    if (n !== 'code') assert.ok(vols.length >= 5, `${n}: binds parsed (${vols.length})`)
  }
  assert.doesNotMatch(compose, /^volumes:/m, 'no named volumes')
})

it('compose: backup verifies the dump in hook archives; quarantine kept out of hook archives', () => {
  assert.match(compose, /^      hook:\n        present:\n          - data\/backup\/db\/nextcloud\.sql\n          - data\/backup\/db\/nextcloud\.sql\.id\n/m)
  assert.match(compose, /^    hookExclude:\n      - data\/db .*\n      - data\/nextcloud\/data\/\.idea-backup-pending .*\n      - data\/db-quarantine .*\n/m)
  assert.match(compose, /^      present:\n        - \.env\n        - data\/nextcloud\/config\/config\.php\n        - data\/nextcloud\/version\.php\n        - hooks\/backup-db-dump\.sh\n      absent: \[\]\n/m, 'flat list unchanged (also true of stop/cold archives)')
})
