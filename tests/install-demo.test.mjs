// demo/install-demo.sh against a mocked Engine queue, occ and WebDAV. Run: node --test tests/
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(root, 'demo/install-demo.sh')
const real = { id: 'nextcloud-1.0', name: 'Nextcloud', status: 'Running', port: 8080, storedOn: 'DISK1', device: 'sdb1', diskName: 'D1' }
const DEMO_USERS = ['admin', 'teacher1', 'teacher2', 'learner1', 'learner2', 'learner3']

function setup(instances = [structuredClone(real)], users = { admin: { groups: ['admin'], pass: 'x' } }) {
  const dir = mkdtempSync(join(tmpdir(), 'ncdemo-'))
  const state = join(dir, 'st.json'), occ = join(dir, 'occ.json'), dav = join(dir, 'dav.log')
  writeFileSync(state, JSON.stringify({ instances, disks: [{ id: 'DISK1', name: 'D1', device: 'sdb1' }], commands: [] }))
  writeFileSync(occ, JSON.stringify({ users, log: [] }))
  const curl = join(dir, 'curl.sh')
  writeFileSync(curl, `#!/bin/sh\ncase "$*" in *status.php*) exit 0 ;; esac\necho "$@" >> ${dav}\n`, { mode: 0o755 })
  const content = join(root, 'tests/fixtures/idea-demo')
  const run = (args = [], env = {}) => {
    const r = spawnSync('bash', [SCRIPT, '--content', content, ...args], { encoding: 'utf8', env: { ...process.env,
      ENGINE_CMD: `node ${join(root, 'tests/fake-engine.mjs')}`, FAKE_STATE: state,
      OCC: `node ${join(root, 'tests/fake-occ-demo.mjs')}`, FAKE_OCC: occ, CURL: curl, DISKS_ROOT: join(dir, 'disks'), READY_STEP: '0', ...env } })
    const rd = p => { try { return readFileSync(p, 'utf8') } catch { return '' } }
    return { ...r, st: JSON.parse(rd(state)), occ: JSON.parse(rd(occ)), dav: rd(dav) }
  }
  return { run }
}

it('installs a new "Nextcloud Demo" (quoted --name), starts it, seeds users and files', () => {
  const { run } = setup()
  const r = run()
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.st.commands, ['installApp nextcloud-1.0 DISK1 --source DISK1 --name "Nextcloud Demo" --fresh', 'startInstance nextcloud-demo DISK1'])
  assert.deepEqual(Object.keys(r.occ.users).sort(), [...DEMO_USERS].sort())
  for (const u of DEMO_USERS.slice(1)) assert.equal(r.occ.users[u].pass, `${u}911!`)
  assert.deepEqual(r.occ.users.teacher1.groups, ['teachers']); assert.deepEqual(r.occ.users.learner2.groups, ['learners'])
  assert.equal(r.occ.users.admin.pass, 'x', 'existing admin keeps its password')
  assert.match(r.dav, /teacher1:teacher1911! -T .*Worksheets\/sheet.txt http:\/\/127.0.0.1:8099\/remote.php\/dav\/files\/teacher1\/Worksheets\/sheet.txt/)
  assert.match(r.dav, /files\/teacher2\/Teacher%20Notes\/notes.txt/)
  assert.equal(JSON.stringify(r.st.instances[0]), JSON.stringify(real), 'real Nextcloud untouched')
})

it('name parsing: Engine that drops the quoted name -> exit 13, nothing seeded', () => {
  const { run } = setup()
  const r = run([], { FAKE_OLD_PARSER: '1' })
  assert.equal(r.status, 13); assert.deepEqual(r.occ.log, []); assert.equal(r.dav, '')
})

it('rerun re-seeds without a second install or duplicate users', () => {
  const { run } = setup()
  assert.equal(run().status, 0)
  const r = run()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.st.commands.filter(c => c.startsWith('installApp')).length, 1)
  assert.equal(r.st.instances.filter(i => i.name === 'Nextcloud Demo').length, 1)
  assert.equal(r.occ.log.filter(l => l.startsWith('user:add')).length, 5)
  assert.match(r.stdout, /"result":"reseeded"/)
})

it('--force-passwords resets existing users to <name>911!', () => {
  const { run } = setup()
  const r = run(['--force-passwords'])
  assert.equal(r.status, 0, r.stderr); assert.equal(r.occ.users.admin.pass, 'admin911!')
})

it('refuses a non-demo target (exit 11), no command sent', () => {
  const { run } = setup()
  const r = run(['--instance', 'nextcloud-1.0'])
  assert.equal(r.status, 11); assert.deepEqual(r.st.commands, []); assert.deepEqual(r.occ.log, [])
})

it('refuses to seed a "Nextcloud Demo" that holds non-demo users (exit 6), nothing changed', () => {
  const demo = { ...real, id: 'nextcloud-demo', name: 'Nextcloud Demo' }
  const { run } = setup([structuredClone(real), demo], { admin: { groups: ['admin'], pass: 'x' }, alice: { groups: [], pass: 'y' } })
  const r = run()
  assert.equal(r.status, 6); assert.deepEqual(r.occ.log, ['user:list --output=json']); assert.equal(r.dav, '')
})

it('fail-closed: installApp Failed -> exit 12; startInstance Failed -> exit 17', () => {
  let r = setup().run([], { FAKE_FAIL: 'installApp' })
  assert.equal(r.status, 12); assert.deepEqual(r.occ.log, [])
  r = setup().run([], { FAKE_FAIL: 'startInstance' })
  assert.equal(r.status, 17); assert.deepEqual(r.occ.log, [])
})

it('more than one demo instance -> exit 10', () => {
  const d = { ...real, name: 'Nextcloud Demo' }
  assert.equal(setup([{ ...d, id: 'a' }, { ...d, id: 'b' }]).run().status, 10)
})

it('is sourceable from a hook without running', () => {
  const r = spawnSync('bash', ['-c', `source ${SCRIPT} && type main >/dev/null && echo sourced`], { encoding: 'utf8' })
  assert.equal(r.stdout.trim(), 'sourced')
})

it('--source names the bundle disk; installApp always carries --fresh', () => {
  const { run } = setup()
  const r = run(['--disk', 'DISK1', '--source', 'APPS', '--app', 'nextcloud-abc'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.st.commands[0], 'installApp nextcloud-abc DISK1 --source APPS --name "Nextcloud Demo" --fresh')
})

it('refuses an instance whose compose.yaml instanceName is not "Nextcloud Demo" (exit 11), nothing seeded', () => {
  const { run } = setup()
  const r = run([], { FAKE_COMPOSE_NAME: 'Nextcloud' })
  assert.equal(r.status, 11, r.stderr); assert.deepEqual(r.occ.log, []); assert.equal(r.dav, '')
})

it('waits for the first-start self-install; never seeds a Nextcloud that is not installed (exit 14)', () => {
  const { run } = setup()
  const r = run([], { FAKE_NOT_INSTALLED: '1', READY_WAIT: '2' })
  assert.equal(r.status, 14, r.stderr); assert.deepEqual(r.occ.log, []); assert.equal(r.dav, '')
})
