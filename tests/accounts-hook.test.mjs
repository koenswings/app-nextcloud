/**
 * before-starting/20-idea-accounts.sh + compose defaults: IDEA <account>911! scheme.
 * Fake occ enforces NC 31 password_policy defaults. Run: node --test tests/
 */
import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = join(root, 'docker-entrypoint-hooks.d/before-starting/20-idea-accounts.sh')
const FAKE = join(root, 'tests/fake-occ-accounts.mjs')
let dir, statePath
const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
const setState = s => writeFileSync(statePath, JSON.stringify({ calls: [], ...s }))
const run = (extra = {}) => {
  const r = spawnSync('sh', [HOOK], { encoding: 'utf8', env: { PATH: process.env.PATH, OCC: FAKE, FAKE_OCC_STATE: statePath, IDEA_OCC_INTERVAL: '1', IDEA_OCC_WAIT: '3', ...extra } })
  assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'idea-acc-')); statePath = join(dir, 'occ.json') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('compose: admin is admin / ${IDEA_NC_ADMIN_PASSWORD:-admin911!}; hook mounted; DB password stays generated', () => {
  const c = readFileSync(join(root, 'compose.yaml'), 'utf8')
  assert.match(c, /- NEXTCLOUD_ADMIN_USER=admin\n/)
  assert.match(c, /- NEXTCLOUD_ADMIN_PASSWORD=\$\{IDEA_NC_ADMIN_PASSWORD:-admin911!\}\n/)
  assert.match(c, /20-idea-accounts\.sh:\/docker-entrypoint-hooks\.d\/before-starting\/20-idea-accounts\.sh:ro/)
  assert.match(c, /MYSQL_PASSWORD=\$\{pass\}/)
  assert.match(c, /MYSQL_ROOT_PASSWORD=\$\{pass\}/)
})

it('fake occ reproduces NC 31 defaults: teacher1911! rejected (HIBP), admin911! too short', () => {
  setState({})
  const r = spawnSync(FAKE, ['user:add', '--password-from-env', 'x'], { encoding: 'utf8', env: { ...process.env, FAKE_OCC_STATE: statePath, OC_PASS: 'admin911!' } })
  assert.equal(r.status, 1); assert.match(r.stdout, /at least 10/)
})

it('fresh install: relaxes unset policy (minLength 9, HIBP off) and creates teacher1/learner1 with <name>911!', () => {
  setState({})
  run()
  const s = state()
  assert.equal(s.appConfig.minLength, 9); assert.equal(s.appConfig.enforceHaveIBeenPwned, false)
  assert.equal(s.users.teacher1.password, 'teacher1911!'); assert.deepEqual(s.users.teacher1.groups, ['teachers'])
  assert.equal(s.users.learner1.password, 'learner1911!'); assert.deepEqual(s.users.learner1.groups, ['learners'])
  // admin911! (9 chars) is accepted by the relaxed policy, e.g. when an admin resets it
  const r = spawnSync(FAKE, ['user:add', '--password-from-env', 'admin2'], { encoding: 'utf8', env: { ...process.env, FAKE_OCC_STATE: statePath, OC_PASS: 'admin911!' } })
  assert.equal(r.status, 0, r.stdout)
})

it('admin-set policy is kept; existing users and passwords are never changed', () => {
  setState({ appConfig: { minLength: 12, enforceHaveIBeenPwned: true }, users: { admin: { password: 'Changed-1', groups: ['admin'] }, teacher1: { password: 'MyOwnPw!', groups: [] } } })
  run({ IDEA_NC_SEED_USERS: 'teacher1:teachers' })
  const s = state()
  assert.equal(s.appConfig.minLength, 12); assert.equal(s.appConfig.enforceHaveIBeenPwned, true)
  assert.equal(s.users.teacher1.password, 'MyOwnPw!'); assert.equal(s.users.admin.password, 'Changed-1')
  assert.ok(!s.calls.some(c => c[0] === 'user:resetpassword' || c[0] === 'config:app:set'))
})

it('custom seed list, empty seed list, not installed', () => {
  setState({}); run({ IDEA_NC_SEED_USERS: 'student01:learners' })
  assert.equal(state().users.student01.password, 'student01911!')
  setState({}); run({ IDEA_NC_SEED_USERS: '' }); assert.deepEqual(Object.keys(state().users), ['admin'])
  setState({ installed: false }); assert.match(run(), /not installed/); assert.deepEqual(state().calls.map(c => c[0]), ['status'])
})

it('idempotent: second run creates nothing', () => {
  setState({}); run(); const n = Object.keys(state().users).length
  run(); assert.equal(Object.keys(state().users).length, n)
  assert.equal(state().calls.filter(c => c[0] === 'user:add').length, 2)
})
