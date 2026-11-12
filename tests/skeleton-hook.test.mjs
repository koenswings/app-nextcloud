/**
 * post-installation/26-idea-skeleton.sh (symlinked in before-starting):
 * empty skeletondirectory and templatedirectory so a first login copies
 * no example files (idea#464). Run: node --test tests/
 */
import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, lstatSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const POST = join(root, 'docker-entrypoint-hooks.d/post-installation/26-idea-skeleton.sh')
const BEFORE = join(root, 'docker-entrypoint-hooks.d/before-starting/26-idea-skeleton.sh')
const FAKE = join(root, 'tests/fake-occ.mjs')
let dir, statePath
const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
const setState = s => writeFileSync(statePath, JSON.stringify({ calls: [], system: {}, ...s }))
const run = (hook = POST) => {
  const r = spawnSync(hook, [], { encoding: 'utf8', env: { PATH: process.env.PATH, OCC: FAKE, FAKE_OCC_STATE: statePath } })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  return r.stdout
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idea-skel-'))
  statePath = join(dir, 'occ.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('hook is executable in post-installation; before-starting is a symlink to it', () => {
  const st = lstatSync(POST)
  assert.ok(st.mode & 0o111, 'post-installation hook must be executable')
  assert.ok(lstatSync(BEFORE).isSymbolicLink())
  assert.equal(realpathSync(BEFORE), realpathSync(POST))
})

it('not installed: skip, only status, no config writes', () => {
  setState({ installed: false })
  assert.match(run(), /not installed yet/)
  assert.deepEqual(state().calls.map(c => c[0]), ['status'])
  assert.deepEqual(state().system, {})
})

it('fresh install (keys unset): sets skeletondirectory and templatedirectory to empty', () => {
  setState({ installed: true })
  const out = run()
  assert.match(out, /set skeletondirectory= \(empty\)/)
  assert.match(out, /set templatedirectory= \(empty\)/)
  assert.equal(state().system.skeletondirectory, '')
  assert.equal(state().system.templatedirectory, '')
  const sets = state().calls.filter(c => c[0] === 'config:system:set')
  assert.equal(sets.length, 2)
  for (const c of sets) {
    assert.ok(c.includes('--type=string'))
    assert.ok(c.includes('--value='))
    assert.equal((c.find(x => x.startsWith('--value=')) ?? '').slice(8), '')
  }
})

it('existing install with stock paths: empties both (updateApp / restart)', () => {
  setState({
    installed: true,
    system: {
      skeletondirectory: '/var/www/html/core/skeleton',
      templatedirectory: '/var/www/html/core/skeleton/Templates',
    },
  })
  // Same script as post-installation; this is the before-starting path.
  run(BEFORE)
  assert.equal(state().system.skeletondirectory, '')
  assert.equal(state().system.templatedirectory, '')
})

it('already empty: no config:system:set (idempotent)', () => {
  setState({ installed: true, system: { skeletondirectory: '', templatedirectory: '' } })
  run()
  assert.deepEqual(state().calls.filter(c => c[0] === 'config:system:set'), [])
  assert.equal(state().system.skeletondirectory, '')
  assert.equal(state().system.templatedirectory, '')
})

it('only the key that is still a path is rewritten', () => {
  setState({
    installed: true,
    system: { skeletondirectory: '', templatedirectory: '/var/www/html/core/skeleton/Templates' },
  })
  run()
  const sets = state().calls.filter(c => c[0] === 'config:system:set')
  assert.equal(sets.length, 1)
  assert.equal(sets[0][1], 'templatedirectory')
  assert.equal(state().system.skeletondirectory, '')
  assert.equal(state().system.templatedirectory, '')
})
