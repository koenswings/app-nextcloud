/**
 * usb-sync.sh (idea#193) with the fake occ (tests/fake-occ-files.mjs). Run: node --test tests/
 */
import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, spawn } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(root, 'usb-sync.sh')
const FAKE = join(root, 'tests/fake-occ-files.mjs')
let dir, statePath, usb, lock
const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
const setState = s => writeFileSync(statePath, JSON.stringify({ calls: [], groups: { admin: ['admin'] }, ...s }))
const env = extra => ({ PATH: process.env.PATH, OCC: FAKE, FAKE_OCC_STATE: statePath, IDEA_USB_ROOT: usb,
  IDEA_USB_LOCK: lock, IDEA_OCC_INTERVAL: '1', IDEA_OCC_WAIT: '5', ...extra })
const run = (extra = {}) => {
  const r = spawnSync('sh', [SCRIPT], { encoding: 'utf8', env: env(extra) })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  return r.stdout
}
const writes = calls => calls.filter(c => !['status', 'files_external:list', 'group:list', 'app:enable'].includes(c[0]))
const stick = (dev, label) => mkdirSync(join(usb, dev), { recursive: true })
const json = obj => writeFileSync(join(usb, '.idea-usb.json'), JSON.stringify(obj))
const own = () => state().mounts.filter(m => m.options.idea_usb)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idea-usb-')); statePath = join(dir, 'occ.json')
  usb = join(dir, 'idea-usb'); lock = join(dir, 'lock'); mkdirSync(usb)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('plug: creates "USB: <label>" read-only, no sharing, check-changes, teachers + admin', () => {
  stick('sdb1'); json([{ stickId: 'usb-1234-ABCD', device: 'sdb1', label: 'MARY-STICK', displayName: 'USB: MARY-STICK' }])
  setState({})
  run()
  const [m] = state().mounts
  assert.equal(m.mount_point, '/USB: MARY-STICK')
  assert.equal(m.configuration.datadir, join(usb, 'sdb1'))
  assert.deepEqual(m.options, { enable_sharing: false, idea_usb: 1, readonly: true, filesystem_check_changes: 1 })
  assert.deepEqual(m.applicable_groups, ['teachers', 'admin'])
  assert.ok(state().groups.teachers)
})

it('names: label-only and map JSON get the "USB: " prefix; no JSON → device; duplicate " (2)" kept', () => {
  stick('sdb1'); stick('sdc1'); stick('sdd')
  json({ sdb1: 'KEY', sdc1: { displayName: 'USB: KEY (2)' } })
  setState({})
  run()
  assert.deepEqual(state().mounts.map(m => m.mount_point).sort(), ['/USB: KEY', '/USB: KEY (2)', '/USB: sdd'])
})

it('wildcards and slashes in labels stay literal / safe', () => {
  stick('sdb1'); writeFileSync(join(dir, 'x'), ''); json([{ device: 'sdb1', label: '*  a/b' }])
  setState({})
  run()
  assert.equal(state().mounts[0].mount_point, '/USB: *  a-b')
})

it('unplug: own storage deleted; other own and admin storages untouched', () => {
  stick('sdc1'); json([{ device: 'sdc1', displayName: 'USB: B' }])
  const adminGone = join(usb, 'sdz9')
  setState({ groups: { admin: ['admin'], teachers: [] }, mounts: [
    { mount_id: 1, mount_point: '/USB: A', configuration: { datadir: join(usb, 'sdb1') }, options: { idea_usb: 1, readonly: true }, applicable_groups: ['teachers', 'admin'] },
    { mount_id: 2, mount_point: '/Admin USB', configuration: { datadir: adminGone }, options: {}, applicable_groups: [] },
    { mount_id: 3, mount_point: '/School Files', configuration: { datadir: '/mnt/idea-files/x' }, options: { idea_files: 1 }, applicable_groups: [] }] })
  run()
  const s = state()
  assert.deepEqual(s.mounts.map(m => m.mount_point), ['/Admin USB', '/School Files', '/USB: B'])
  assert.deepEqual(s.mounts[0].options, {}); assert.deepEqual(s.mounts[1].options, { idea_files: 1 })
  assert.ok(!s.calls.some(c => c[0] === 'files_external:delete' && c[2] !== '1'))
})

it('admin storage on a stick folder: no duplicate, admin storage unchanged', () => {
  stick('sdb1')
  setState({ mounts: [{ mount_id: 5, mount_point: '/Mine', configuration: { datadir: join(usb, 'sdb1') }, options: {}, applicable_groups: [] }] })
  run()
  assert.equal(state().mounts.length, 1); assert.deepEqual(state().mounts[0].options, {})
})

it('other stick on the same device (missed unplug): renamed via delete + create', () => {
  stick('sdb1'); json([{ device: 'sdb1', displayName: 'USB: NEW' }])
  setState({ mounts: [{ mount_id: 1, mount_point: '/USB: OLD', configuration: { datadir: join(usb, 'sdb1') }, options: { idea_usb: 1 }, applicable_groups: [] }] })
  run()
  assert.deepEqual(state().mounts.map(m => [m.mount_point, m.options.readonly]), [['/USB: NEW', true]])
})

it('idempotent: second run only refreshes filesystem_check_changes', () => {
  stick('sdb1'); stick('sdc1'); setState({})
  run(); const before = state(); const n = before.calls.length
  run(); const after = state()
  assert.deepEqual(after.mounts, before.mounts)
  const w = writes(after.calls.slice(n))
  assert.ok(w.every(c => c[0] === 'files_external:option' && c[2] === 'filesystem_check_changes'), JSON.stringify(w))
})

it('repairs own storage that lost readonly / gained sharing', () => {
  stick('sdb1')
  setState({ mounts: [{ mount_id: 1, mount_point: '/USB: sdb1', configuration: { datadir: join(usb, 'sdb1') }, options: { idea_usb: 1, readonly: false, enable_sharing: true }, applicable_groups: [] }] })
  run()
  const m = state().mounts[0]
  assert.equal(m.options.readonly, true); assert.equal(m.options.enable_sharing, false)
  assert.deepEqual(m.applicable_groups, ['teachers', 'admin'])
})

it('custom IDEA_TEACHERS_GROUP; invalid group → admin only', () => {
  stick('sdb1'); setState({ groups: { admin: ['admin'], staff: [] } })
  run({ IDEA_TEACHERS_GROUP: 'staff' })
  assert.deepEqual(state().mounts[0].applicable_groups, ['staff', 'admin'])
  setState({ mounts: [] })
  assert.match(run({ IDEA_TEACHERS_GROUP: 'bad;x' }), /invalid/)
  assert.deepEqual(state().mounts[0].applicable_groups, ['admin'])
})

it('fail open: occ never ready → exit 0, nothing deleted; not installed → no writes; root absent → skip', () => {
  setState({ notReady: 99, mounts: [{ mount_id: 1, mount_point: '/USB: A', configuration: { datadir: join(usb, 'gone') }, options: { idea_usb: 1 }, applicable_groups: [] }] })
  assert.match(run({ IDEA_OCC_WAIT: '2' }), /not ready after 2s/)
  assert.equal(state().mounts.length, 1); assert.deepEqual(writes(state().calls), [])
  setState({ installed: false }); assert.match(run(), /not installed/)
  assert.deepEqual(state().calls.map(c => c[0]), ['status'])
  rmSync(usb, { recursive: true }); setState({}); assert.match(run(), /absent/)
  assert.deepEqual(state().calls, [])
})

it('occ slow at start: waits, then reconciles', () => {
  stick('sdb1'); setState({ notReady: 2 })
  assert.match(run(), /occ ready after 2s/); assert.equal(own().length, 1)
})

it('concurrent runs (plug + unplug burst) serialise: one storage, lock released', async () => {
  stick('sdb1'); setState({})
  const p = () => new Promise(res => spawn('sh', [SCRIPT], { env: env({}) }).on('exit', res))
  assert.deepEqual(await Promise.all([p(), p(), p()]), [0, 0, 0])
  assert.equal(state().mounts.length, 1); assert.ok(!existsSync(lock))
})

// ---- Engine contract (agent-engine-dev PR #205, docs/USB-STICKS.md) ----
const S = (device, name) => ({ stickId: `usb-${device}`, device, label: name, displayName: `USB: ${name}` })
const ownAt = (id, dev, name) => ({ mount_id: id, mount_point: `/USB: ${name}`, configuration: { datadir: join(usb, dev) }, options: { idea_usb: 1, readonly: true, enable_sharing: false }, applicable_groups: ['teachers', 'admin'] })

it('contract: unplug with folder still mounted → JSON wins, storage deleted', () => {
  stick('sdb1'); stick('sdc1')
  json({ version: 1, sticks: [S('sdc1', 'B')] })
  setState({ groups: { admin: ['admin'], teachers: [] }, mounts: [ownAt(1, 'sdb1', 'A'), ownAt(2, 'sdc1', 'B')] })
  assert.match(run({ IDEA_USB_EVENT: 'unplug' }), /event=unplug JSON ok \(1 stick/)
  assert.deepEqual(state().mounts.map(m => m.mount_point), ['/USB: B'])
})

it('contract: valid JSON does not create storages for folders it does not list', () => {
  stick('sdb1'); stick('sdc1'); json({ version: 1, sticks: [S('sdc1', 'B')] }); setState({})
  run({ IDEA_USB_EVENT: 'plug' })
  assert.deepEqual(state().mounts.map(m => m.mount_point), ['/USB: B'])
})

it('contract: empty sticks list at start → own storages removed, admin kept', () => {
  stick('sdb1'); json({ version: 1, sticks: [] })
  setState({ mounts: [ownAt(1, 'sdb1', 'A'), { mount_id: 2, mount_point: '/Mine', configuration: { datadir: join(usb, 'sdb1') }, options: {}, applicable_groups: [] }] })
  run({ IDEA_USB_EVENT: 'start' })
  assert.deepEqual(state().mounts.map(m => m.mount_point), ['/Mine'])
})

for (const [what, write] of [
  ['missing', () => {}],
  ['unparsable', () => writeFileSync(join(usb, '.idea-usb.json'), '{"version":1,"sticks":[')],
  ['sticks not an array', () => json({ version: 1, sticks: {} })],
  ['bad device entry', () => json({ version: 1, sticks: [{ device: '../x' }] })],
]) {
  it(`contract: JSON ${what} → folder rule, nothing deleted for present folders`, () => {
    stick('sdb1'); write()
    setState({ groups: { admin: ['admin'], teachers: [] }, mounts: [ownAt(1, 'sdb1', 'sdb1'), ownAt(2, 'gone', 'G')] })
    assert.match(run({ IDEA_USB_EVENT: 'unplug' }), /JSON missing\/invalid/)
    assert.deepEqual(state().mounts.map(m => m.mount_point), ['/USB: sdb1'])
    assert.ok(!state().calls.some(c => c[0] === 'files_external:delete' && c[2] === '1'))
  })
}

it('contract: version field — missing or unknown version is treated as invalid (folder rule)', () => {
  for (const v of [undefined, 2, '1']) {
    stick('sdb1'); json({ ...(v === undefined ? {} : { version: v }), sticks: [] })
    setState({ mounts: [ownAt(1, 'sdb1', 'sdb1')] })
    assert.match(run(), /JSON missing\/invalid/, String(v))
    assert.equal(state().mounts.length, 1, String(v))
  }
  json({ version: 1, sticks: [] }); setState({ mounts: [ownAt(1, 'sdb1', 'sdb1')] })
  assert.match(run(), /JSON ok/); assert.equal(state().mounts.length, 0)
})

it('contract: IDEA_USB_ROOT / IDEA_USB_JSON env overrides (absolute and relative JSON path)', () => {
  const alt = join(dir, 'alt-root'); mkdirSync(join(alt, 'sdx1'), { recursive: true })
  const jp = join(dir, 'elsewhere.json')
  writeFileSync(jp, JSON.stringify({ version: 1, sticks: [S('sdx1', 'ALT')] }))
  setState({})
  run({ IDEA_USB_ROOT: alt, IDEA_USB_JSON: jp })
  assert.equal(state().mounts[0].mount_point, '/USB: ALT')
  assert.equal(state().mounts[0].configuration.datadir, join(alt, 'sdx1'))
  writeFileSync(join(alt, 'rel.json'), JSON.stringify({ version: 1, sticks: [S('sdx1', 'REL')] }))
  run({ IDEA_USB_ROOT: alt, IDEA_USB_JSON: 'rel.json' })
  assert.deepEqual(state().mounts.map(m => m.mount_point), ['/USB: REL'])
})

it('contract: defaults — IDEA_USB_JSON unset reads $ROOT/.idea-usb.json', () => {
  stick('sdb1'); json({ version: 1, sticks: [S('sdb1', 'DEF')] }); setState({})
  assert.match(run(), /JSON ok/); assert.equal(state().mounts[0].mount_point, '/USB: DEF')
})

it('contract: Nextcloud not ready → exit 0 well within 120 s, nothing written', () => {
  stick('sdb1'); json({ version: 1, sticks: [] })
  setState({ notReady: 99, mounts: [ownAt(1, 'sdb1', 'A')] })
  const t = Date.now()
  assert.match(run({ IDEA_OCC_WAIT: '2', IDEA_USB_EVENT: 'start' }), /not ready/)
  assert.ok(Date.now() - t < 20000)
  assert.equal(state().mounts.length, 1); assert.deepEqual(writes(state().calls), [])
})

it('contract: default occ wait is bounded (<=75 s) so total stays under the 120 s timeout', () => {
  const src = readFileSync(SCRIPT, 'utf8')
  assert.match(src, /IDEA_OCC_WAIT:-60/); assert.match(src, /OCC_WAIT=75/); assert.match(src, /-ge 30 \]/)
})

it('php helper: the php -r program contains no single quote (it sits inside a single-quoted sh string)', () => {
  const src = readFileSync(SCRIPT, 'utf8')
  const m = src.match(/php -r '\n([\s\S]*?)\n' "\$mode"/)
  assert.ok(m, 'php -r block not found')
  assert.ok(!m[1].includes("'"), 'single quote inside php -r block breaks sh quoting')
})

it('php helper: same names and device list as node (runs only where php exists, e.g. the Nextcloud image)', { skip: spawnSync('php', ['-v']).status !== 0 }, () => {
  stick('sdb1'); json({ version: 1, sticks: [S('sdb1', 'PHPSTICK')] }); setState({})
  assert.match(run({ IDEA_USB_HELPER: 'php' }), /JSON ok/)
  assert.equal(state().mounts[0].mount_point, '/USB: PHPSTICK')
})

it('Files Disk storages (idea_files=1, /mnt/idea-files) are never touched by usb-sync, even on unplug', () => {
  const fd = { mount_id: 1, mount_point: '/School Files', configuration: { datadir: '/mnt/idea-files/school-files-164250' },
    options: { idea_files: 1, enable_sharing: true }, applicable_users: [], applicable_groups: ['teachers', 'admin'] }
  const stray = { mount_id: 2, mount_point: '/Odd', configuration: { datadir: '/mnt/idea-files/x' },
    options: { idea_usb: 1 }, applicable_users: [], applicable_groups: [] }
  json([]); setState({ mounts: [fd, stray] })
  run({ EVENT: 'remove' })
  assert.deepEqual(state().mounts, [fd, stray])
  assert.ok(!state().calls.some(c => c[0] === 'files_external:delete'))
})
