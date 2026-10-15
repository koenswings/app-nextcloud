/**
 * before-starting/10-idea-files.sh with a fake occ (tests/fake-occ-files.mjs).
 * Run: node --test tests/
 */
import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = join(root, 'docker-entrypoint-hooks.d/before-starting/10-idea-files.sh')
const FAKE = join(root, 'tests/fake-occ-files.mjs')
let dir, statePath, filesRoot
const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
const setState = s => writeFileSync(statePath, JSON.stringify({ calls: [], ...s }))
const run = (extra = {}) => {
  const r = spawnSync('sh', [HOOK], { encoding: 'utf8', env: { PATH: process.env.PATH, OCC: FAKE, FAKE_OCC_STATE: statePath,
    IDEA_FILES_ROOT: filesRoot, IDEA_OCC_INTERVAL: '1', IDEA_OCC_WAIT: '5', ...extra } })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  return r.stdout
}
const writes = calls => calls.filter(c => !['status', 'files_external:list', 'group:list', 'app:enable'].includes(c[0]))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idea-files-')); statePath = join(dir, 'occ.json')
  filesRoot = join(dir, 'idea-files'); mkdirSync(join(filesRoot, 'school-files-164250'), { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('(1) occ not ready at container start: waits, then reconciles', () => {
  setState({ notReady: 2 })
  const out = run()
  assert.match(out, /occ ready after 2s/)
  assert.equal(state().mounts.length, 1)
})

it('(1) occ never ready: bounded wait, exit 0, nothing created or deleted', () => {
  setState({ notReady: 99, mounts: [{ mount_id: 7, mount_point: '/Gone', configuration: { datadir: join(filesRoot, 'gone') }, options: { idea_files: 1 }, applicable_groups: [] }] })
  const t = Date.now(); const out = run({ IDEA_OCC_WAIT: '2' })
  assert.ok(Date.now() - t < 5000)
  assert.match(out, /occ not ready after 2s/)
  assert.equal(state().mounts.length, 1)
  assert.deepEqual(writes(state().calls), [])
})

it('(1) not installed: no wait, no writes', () => {
  setState({ installed: false })
  assert.match(run(), /not installed/)
  assert.deepEqual(state().calls.map(c => c[0]), ['status'])
})

it('(2) new storage: idea_files, enable_sharing true, filesystem_check_changes', () => {
  setState({})
  run()
  const m = state().mounts[0]
  assert.equal(m.configuration.datadir, join(filesRoot, 'school-files-164250'))
  assert.deepEqual(m.options, { enable_sharing: true, idea_files: 1, filesystem_check_changes: 1 })
})

it('(2) existing own storage without sharing (wh state) gets enable_sharing on next start', () => {
  setState({ groups: { admin: ['admin'], teachers: [] }, mounts: [{ mount_id: 1, mount_point: '/School Files', configuration: { datadir: join(filesRoot, 'school-files-164250') },
    options: { enable_sharing: false, filesystem_check_changes: 1, idea_files: 1 }, applicable_users: [], applicable_groups: [] }] })
  run()
  const m = state().mounts[0]
  assert.equal(m.options.enable_sharing, true)
  assert.deepEqual(m.applicable_groups, ['teachers', 'admin'])
})

it('(3) default teachers group is created and storage limited to teachers + admin', () => {
  setState({})
  assert.match(run(), /created group teachers/)
  assert.ok(state().groups.teachers)
  assert.deepEqual(state().mounts[0].applicable_groups, ['teachers', 'admin'])
})

it('(3) IDEA_TEACHERS_GROUP is configurable; existing group not re-created', () => {
  setState({ groups: { admin: ['admin'], 'demo-teachers': ['demo-teacher1'] } })
  run({ IDEA_TEACHERS_GROUP: 'demo-teachers' })
  assert.ok(!state().calls.some(c => c[0] === 'group:add'))
  assert.deepEqual(state().mounts[0].applicable_groups, ['demo-teachers', 'admin'])
})

it('(3) invalid group name: warns, storage still created, not restricted', () => {
  setState({})
  assert.match(run({ IDEA_TEACHERS_GROUP: 'bad;rm -rf' }), /invalid/)
  assert.equal(state().mounts.length, 1)
  assert.ok(!state().calls.some(c => c[0] === 'group:add' || c[0] === 'files_external:applicable'))
})

it('(3) admin-added groups are kept; admin Local storages untouched', () => {
  const adminDir = join(filesRoot, 'admin-made'); mkdirSync(adminDir)
  setState({ groups: { admin: ['admin'], teachers: [], staff: [] }, mounts: [
    { mount_id: 1, mount_point: '/School Files', configuration: { datadir: join(filesRoot, 'school-files-164250') }, options: { idea_files: 1, enable_sharing: true }, applicable_groups: ['staff'] },
    { mount_id: 2, mount_point: '/Admin', configuration: { datadir: adminDir }, options: {}, applicable_groups: [] }] })
  run()
  const [own, adm] = state().mounts
  assert.deepEqual(own.applicable_groups, ['staff', 'teachers', 'admin'])
  assert.deepEqual(adm.applicable_groups, []); assert.deepEqual(adm.options, {})
})

it('idempotent: second start makes no changes except the existing check-changes refresh', () => {
  setState({})
  run(); const before = state(); const n = before.calls.length
  run(); const after = state()
  assert.deepEqual(after.mounts, before.mounts); assert.deepEqual(after.groups, before.groups)
  const w = writes(after.calls.slice(n))
  assert.ok(w.every(c => c[0] === 'files_external:option' && c[2] === 'filesystem_check_changes'), JSON.stringify(w))
})

it('own storage whose folder is gone is KEPT unchanged; files root absent → skip', () => {
  const old = { mount_id: 4, mount_point: '/Old', configuration: { datadir: join(filesRoot, 'old-1') }, options: { idea_files: 1 }, applicable_groups: [] }
  setState({ mounts: [old] })
  assert.match(run(), /keep own storage id=4/)
  const m = state().mounts.find(x => x.mount_id === 4)
  assert.deepEqual(m, old)
  assert.ok(!state().calls.some(c => c[0] === 'files_external:delete'))
  rmSync(filesRoot, { recursive: true }); setState({})
  assert.match(run(), /absent/)
})

const SF = () => join(filesRoot, 'school-files-164250')
const snapshot = m => JSON.parse(JSON.stringify(m))

it('dock → undock (startup, no disk) → redock: same id, same config, groups kept, no duplicate, never deleted', () => {
  setState({ groups: { admin: ['admin'], teachers: [], staff: [] } })
  run()                                       // dock
  let [m] = state().mounts
  assert.equal(m.mount_id, 1)
  // admin adds a group and a share-relevant option after first dock
  const s0 = state(); s0.mounts[0].applicable_groups.push('staff'); writeFileSync(statePath, JSON.stringify(s0))
  const docked = snapshot(state().mounts[0])
  rmSync(SF(), { recursive: true })           // undock: root stays, folder gone (wh incident)
  const out = run()
  assert.match(out, /keep own storage id=1/)
  assert.deepEqual(state().mounts, [docked])
  run()                                       // second undocked start: still unchanged
  assert.deepEqual(state().mounts, [docked])
  mkdirSync(SF())                              // redock
  run()
  const after = state().mounts
  assert.equal(after.length, 1)
  assert.deepEqual(after[0], docked)
  assert.deepEqual(after[0].applicable_groups, ['teachers', 'admin', 'staff'])
  const calls = state().calls
  assert.ok(!calls.some(c => c[0] === 'files_external:delete'))
  assert.equal(calls.filter(c => c[0] === 'files_external:create').length, 1)
})

it('undock with Files root itself empty (no disk folders at all): entry kept', () => {
  const m = { mount_id: 1, mount_point: '/School Files', configuration: { datadir: SF() },
    options: { idea_files: 1, enable_sharing: true, filesystem_check_changes: 1 }, applicable_users: [], applicable_groups: ['teachers', 'admin'] }
  rmSync(SF(), { recursive: true })
  setState({ groups: { admin: ['admin'], teachers: [] }, mounts: [m] })
  run()
  assert.deepEqual(state().mounts, [m])
  assert.deepEqual(writes(state().calls).filter(c => c[0].startsWith('files_external')), [])
})

it('two disks, one undocked: docked one maintained, undocked one unchanged, redock reuses its id', () => {
  const B = join(filesRoot, 'grade5-aaaaaa'); mkdirSync(B)
  setState({ groups: { admin: ['admin'], teachers: [] } })
  run()
  const ids = Object.fromEntries(state().mounts.map(m => [m.configuration.datadir, m.mount_id]))
  assert.equal(state().mounts.length, 2)
  const bBefore = snapshot(state().mounts.find(m => m.configuration.datadir === B))
  rmSync(B, { recursive: true })
  run()
  assert.equal(state().mounts.length, 2)
  assert.deepEqual(state().mounts.find(m => m.configuration.datadir === B), bBefore)
  mkdirSync(B); run()
  const ms = state().mounts
  assert.equal(ms.length, 2)
  assert.deepEqual(Object.fromEntries(ms.map(m => [m.configuration.datadir, m.mount_id])), ids)
  assert.deepEqual(ms.find(m => m.configuration.datadir === B), bBefore)
  assert.ok(!state().calls.some(c => c[0] === 'files_external:delete'))
})

it('admin-created storage under the root (present or absent) is never touched', () => {
  const adm = { mount_id: 9, mount_point: '/Admin', configuration: { datadir: join(filesRoot, 'admin-gone') }, options: {}, applicable_users: [], applicable_groups: ['staff'] }
  setState({ groups: { admin: ['admin'], teachers: [], staff: [] }, mounts: [adm] })
  run(); rmSync(SF(), { recursive: true }); run()
  assert.deepEqual(state().mounts.find(m => m.mount_id === 9), adm)
  assert.ok(!state().calls.some(c => String(c[1]) === '9'))
})
