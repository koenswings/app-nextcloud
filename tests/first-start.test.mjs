/**
 * First start self-installs, then Office + Files Disk hooks run in order.
 * Simulates the official image's entrypoint (run_path: sorted *.sh, exec flag
 * required, symlinks followed; install between pre- and post-installation) with fake occ.
 * Run: node --test tests/
 */
import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOOKS = join(root, 'docker-entrypoint-hooks.d')
const FAKE_OCC = join(root, 'tests/fake-occ.mjs')
const URL = 'http://192.168.0.231:9980'
let dir, statePath, filesRoot
const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
const setState = (s) => writeFileSync(statePath, JSON.stringify({ calls: [], ...s }))
const env = (extra = {}) => ({ PATH: process.env.PATH, OCC: FAKE_OCC, FAKE_OCC_STATE: statePath,
  IDEA_FILES_ROOT: filesRoot, IDEA_COLLABORA_URL: URL, ...extra })

function runPath(folder, e, log) {
  const p = join(HOOKS, folder)
  if (!existsSync(p)) return
  for (const f of readdirSync(p).filter(f => f.endsWith('.sh')).sort()) {
    const full = join(p, f)
    if (!(statSync(full).mode & 0o111)) { log.push(`skip-noexec ${folder}/${f}`); continue }
    const r = spawnSync(full, [], { env: e, encoding: 'utf8' })
    assert.equal(r.status, 0, `${folder}/${f} must exit 0: ${r.stdout}${r.stderr}`)
    log.push(`${folder}/${f}`)
  }
}
// Mirrors docker-entrypoint.sh: install block only when not installed and admin creds set.
function start(e) {
  const log = []
  if (!state().installed && e.NEXTCLOUD_ADMIN_USER && e.NEXTCLOUD_ADMIN_PASSWORD) {
    runPath('pre-installation', e, log)
    spawnSync(FAKE_OCC, ['maintenance:install'], { env: e }); log.push('install')
    runPath('post-installation', e, log)
  }
  runPath('before-starting', e, log)
  return log
}
const creds = { NEXTCLOUD_ADMIN_USER: 'admin', NEXTCLOUD_ADMIN_PASSWORD: 'x' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idea-fs-')); statePath = join(dir, 'occ.json')
  filesRoot = join(dir, 'idea-files'); mkdirSync(join(filesRoot, 'grade5-abc123'), { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('compose: auto-install env set, whole hooks dir mounted, no Office before install', () => {
  const c = readFileSync(join(root, 'compose.yaml'), 'utf8')
  for (const k of ['NEXTCLOUD_ADMIN_USER=', 'NEXTCLOUD_ADMIN_PASSWORD=${pass}', 'MYSQL_HOST=', 'IDEA_COLLABORA_URL=http://${ip}:9980'])
    assert.ok(c.includes(k), k)
  assert.ok(c.includes('./docker-entrypoint-hooks.d:/docker-entrypoint-hooks.d:ro'))
  assert.ok(!existsSync(join(HOOKS, 'pre-installation')), 'nothing may need occ before install')
})

it('first start: installs, Office in post-installation, then Files + Office in before-starting', () => {
  setState({ installed: false, appsPresent: ['richdocuments', 'files_external'] })
  const log = start(env(creds))
  assert.deepEqual(log, ['install', 'post-installation/30-idea-office.sh',
    'before-starting/10-idea-files.sh', 'before-starting/30-idea-office.sh'])
  const s = state()
  assert.equal(s.installed, true)
  assert.equal(s.app.richdocuments.wopi_url, URL)
  assert.equal(s.app.richdocuments.public_wopi_url, URL)
  assert.equal(s.system.allow_local_remote_servers, true)
  assert.equal(s.mounts.length, 1)
  assert.equal(s.mounts[0].configuration.datadir, join(filesRoot, 'grade5-abc123'))
  // Office ran before Files in post-installation; no occ write was attempted while uninstalled
  const firstInstall = s.calls.findIndex(c => c[0] === 'maintenance:install')
  assert.ok(s.calls.slice(0, firstInstall).every(c => c[0] === 'status'))
})

it('second start: no install, Office idempotent (no writes)', () => {
  setState({ installed: false, appsPresent: ['richdocuments', 'files_external'] })
  start(env(creds))
  const n = state().calls.length
  const log = start(env(creds))
  assert.deepEqual(log, ['before-starting/10-idea-files.sh', 'before-starting/30-idea-office.sh'])
  const later = state().calls.slice(n).map(c => c[0])
  assert.ok(!later.includes('maintenance:install'))
  assert.ok(!later.includes('config:app:set') && !later.includes('config:system:set'), later.join(','))
  assert.equal(state().mounts.length, 1)
})

it('IP change: Office URL follows on next start', () => {
  setState({ installed: false, appsPresent: ['richdocuments', 'files_external'] })
  start(env(creds))
  start(env({ ...creds, IDEA_COLLABORA_URL: 'http://10.0.0.5:9980' }))
  assert.equal(state().app.richdocuments.wopi_url, 'http://10.0.0.5:9980')
})

it('offline without richdocuments: warns, NC still starts, Files Disk still works', () => {
  setState({ installed: false, appsPresent: ['files_external'], online: false })
  const r = spawnSync(join(HOOKS, 'post-installation/30-idea-office.sh'), [], { env: env(), encoding: 'utf8' })
  assert.equal(r.status, 0); assert.match(r.stdout, /not installed yet/)
  const log = start(env(creds))
  assert.equal(log.length, 4)
  assert.equal(state().app.richdocuments, undefined)
  assert.equal(state().mounts.length, 1)
})

it('no admin creds (old behaviour): no install, hooks skip quietly', () => {
  setState({ installed: false, appsPresent: ['richdocuments'] })
  const log = start(env())
  assert.deepEqual(log, ['before-starting/10-idea-files.sh', 'before-starting/30-idea-office.sh'])
  assert.equal(state().installed, false)
  assert.ok(state().calls.every(c => ['status', 'app:enable', 'files_external:list'].includes(c[0])), JSON.stringify(state().calls))
})

it('empty or bad IDEA_COLLABORA_URL: skip, no occ calls', () => {
  setState({ installed: true, appsPresent: ['richdocuments'] })
  for (const u of ['', 'javascript:x']) {
    const r = spawnSync(join(HOOKS, 'before-starting/30-idea-office.sh'), [], { env: env({ IDEA_COLLABORA_URL: u }), encoding: 'utf8' })
    assert.equal(r.status, 0)
  }
  assert.deepEqual(state().calls, [])
})
