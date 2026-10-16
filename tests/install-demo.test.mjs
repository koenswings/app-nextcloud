// Unit tests for demo/install-demo.sh with a stub Engine and stub docker/curl (no containers).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'demo', 'install-demo.sh')
const inst = (id, name, status = 'Running') => ({ id, name, status, port: 1, storedOn: 'd1', device: 'sdb1', diskName: 'D' })

function setup(list, { project, composeName = 'Nextcloud-Demo' } = {}) {
  const s = fs.mkdtempSync(path.join(os.tmpdir(), 'ncdemo-'))
  fs.writeFileSync(path.join(s, 'list.json'), JSON.stringify(list))
  fs.writeFileSync(path.join(s, 'after.json'), JSON.stringify([...list, inst('nextcloud-new', 'Nextcloud-Demo')]))
  const w = (n, body) => { fs.writeFileSync(path.join(s, n), '#!/usr/bin/env bash\n' + body); fs.chmodSync(path.join(s, n), 0o755) }
  const mkInst = id => { const d = path.join(s, 'disks/sdb1/instances', id); fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'compose.yaml'), `x-app:\n  instanceName: ${composeName}\n`); fs.writeFileSync(path.join(d, '.env'), 'port=1\nhostname=h\nip=1.2.3.4\n') }
  for (const i of list) mkInst(i.id)
  w('ec.sh', `echo "ec $*" >> "${s}/calls"
case "$1" in list) cat "${s}/list.json";; send) [[ "$2" == installApp* ]] && { cp "${s}/after.json" "${s}/list.json"; mkdir -p "${s}/disks/sdb1/instances/nextcloud-new"; printf 'x-app:\\n  instanceName: Nextcloud-Demo\\n' > "${s}/disks/sdb1/instances/nextcloud-new/compose.yaml"; printf 'port=1\\n' > "${s}/disks/sdb1/instances/nextcloud-new/.env"; };; esac\n`)
  w('docker.sh', `echo "docker $*" >> "${s}/calls"
case "$1" in inspect) echo "${project ?? '$(echo "$4" | sed s/-nextcloud-app-1//)'}";; exec) case "$*" in *"occ status"*) echo "installed: true";; esac;; esac\n`)
  w('curl.sh', `echo "curl $*" >> "${s}/calls"; case "$*" in *"-X POST"*) echo 200;; *"-w"*) echo 201;; *"-I"*) echo "Content-Length: 0";; *shares*) echo '{"ocs":{"data":[]}}';; esac\n`)
  fs.mkdirSync(path.join(s, 'files/Worksheets'), { recursive: true }); fs.mkdirSync(path.join(s, 'files/Teacher Notes'))
  fs.writeFileSync(path.join(s, 'files/Worksheets/a.pdf'), 'x')
  return s
}
function run(s, ...args) {
  const r = spawnSync('bash', [SCRIPT, '--files', path.join(s, 'files'), ...args], { encoding: 'utf8',
    env: { ...process.env, ENGINE_CMD: path.join(s, 'ec.sh'), DOCKER: path.join(s, 'docker.sh'), CURL: path.join(s, 'curl.sh'),
      DISKS_ROOT: path.join(s, 'disks'), READY_WAIT: '1' } })
  const calls = fs.existsSync(path.join(s, 'calls')) ? fs.readFileSync(path.join(s, 'calls'), 'utf8').split('\n') : []
  return { code: r.status, calls, err: r.stderr }
}

test('name must be one word containing demo', () => {
  const s = setup([])
  for (const n of ['Nextcloud Demo', 'nextcloud']) assert.equal(run(s, '--name', n, '--disk', 'd1').code, 2)
})
test('ambiguous name refused before any command', () => {
  const s = setup([inst('a', 'Nextcloud-Demo'), inst('b', 'Nextcloud-Demo')])
  const r = run(s, '--disk', 'd1'); assert.equal(r.code, 12)
  assert.ok(!r.calls.some(c => c.startsWith('ec send') || c.startsWith('docker')))
})
test('exact name only: another nextcloud is never used; new one installed', () => {
  const s = setup([inst('nextcloud-x', 'nextcloud'), inst('nextcloud-y', 'nextcloud-demo')])
  const r = run(s, '--disk', 'd1')
  assert.equal(r.code, 0, r.err)
  assert.ok(r.calls.includes('ec send installApp nextcloud-latest d1 --name Nextcloud-Demo'))
  assert.ok(!r.calls.some(c => /nextcloud-[xy]/.test(c)))
  assert.ok(r.calls.some(c => c.includes('exec -u www-data -e IDEA_NC_SEED_USERS=teacher1:teachers teacher2:teachers learner1:learners learner2:learners learner3:learners')))
  assert.ok(r.calls.some(c => c.includes('-T') && c.includes('a.pdf')))
})
test('rerun reuses the instance, no second install', () => {
  const r = run(setup([inst('nextcloud-new', 'Nextcloud-Demo')]))
  assert.equal(r.code, 0, r.err); assert.ok(!r.calls.some(c => c.includes('installApp')))
})
test('refuses when compose name differs', () => {
  const r = run(setup([inst('nextcloud-new', 'Nextcloud-Demo')], { composeName: 'nextcloud' }))
  assert.equal(r.code, 13); assert.ok(!r.calls.some(c => c.startsWith('docker exec')))
})
test('refuses when the app container belongs to another project', () => {
  const r = run(setup([inst('nextcloud-new', 'Nextcloud-Demo')], { project: 'nextcloud-grade5a-001' }))
  assert.equal(r.code, 13); assert.ok(!r.calls.some(c => c.startsWith('docker exec')))
})
test('refuses another disk', () => {
  const r = run(setup([inst('nextcloud-new', 'Nextcloud-Demo')]), '--disk', 'elsewhere')
  assert.equal(r.code, 13)
})
