/**
 * Tests for docker-entrypoint-hooks.d/before-starting/20-idea-trusted-domains.sh
 * against fake-occ-trusted.mjs (agent-engine-dev#163). Run: node --test tests/
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const HOOK = join(here, '../docker-entrypoint-hooks.d/before-starting/20-idea-trusted-domains.sh')
const FAKE_OCC = join(here, 'fake-occ-trusted.mjs')

let dir, statePath
const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
const setState = (s) => writeFileSync(statePath, JSON.stringify({ ready: true, calls: [], ...s }))
const td = () => state().system.trusted_domains
const managed = () => state().system.idea_trusted_domains_managed
const writes = () => state().calls.filter(c => c[0] !== 'status' && c[0] !== 'config:system:get')
const run = (env, cwd) => {
  const r = spawnSync('sh', [HOOK], {
    cwd,
    env: { PATH: process.env.PATH, OCC: FAKE_OCC, FAKE_OCC_STATE: statePath, ...env },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `hook must exit 0 (fail open): ${r.stderr}${r.stdout}`)
  return r
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idea-td-'))
  statePath = join(dir, 'occ.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('20-idea-trusted-domains.sh', () => {
  it('first run on a copied instance: writes localhost, host, host.local and every IP; the old host stays as an unmanaged entry', () => {
    setState({ system: { trusted_domains: ['idea01:18280'] } })
    const r = run({ IDEA_HOSTNAME: 'idea03', IDEA_HOST_IPS: '10.99.0.13,100.126.117.80' })
    assert.deepEqual(td(), ['localhost', 'idea03', 'idea03.local', '10.99.0.13', '100.126.117.80', 'idea01:18280'])
    assert.deepEqual(managed(), ['idea03', 'idea03.local', '10.99.0.13', '100.126.117.80'])
    assert.match(r.stdout, /kept: idea01:18280/)
  })

  it('idempotent: a second run with the same env writes nothing', () => {
    setState({ system: { trusted_domains: ['localhost'] } })
    run({ IDEA_HOSTNAME: 'idea03', IDEA_HOST_IPS: '10.99.0.13' })
    const before = td()
    setState({ system: state().system })          // reset the call log
    const r = run({ IDEA_HOSTNAME: 'idea03', IDEA_HOST_IPS: '10.99.0.13' })
    assert.deepEqual(writes(), [])
    assert.deepEqual(td(), before)
    assert.match(r.stdout, /already up to date/)
  })

  it('re-dock on another Pi / changed IP: only the hook\'s own entries are replaced, stale tail removed', () => {
    setState({ system: { trusted_domains: [] } })
    run({ IDEA_HOSTNAME: 'idea03', IDEA_HOST_IPS: '10.99.0.13,100.126.117.80' })
    run({ IDEA_HOSTNAME: 'idea04', IDEA_HOST_IPS: '10.99.0.14' })
    assert.deepEqual(td(), ['localhost', 'idea04', 'idea04.local', '10.99.0.14'])
    assert.deepEqual(managed(), ['idea04', 'idea04.local', '10.99.0.14'])
    // same Pi, DHCP gave a new LAN address
    run({ IDEA_HOSTNAME: 'idea04', IDEA_HOST_IPS: '192.168.0.57' })
    assert.deepEqual(td(), ['localhost', 'idea04', 'idea04.local', '192.168.0.57'])
  })

  it('admin-added entries are preserved across runs and host changes', () => {
    setState({ system: { trusted_domains: ['localhost', 'cloud.school.example'] } })
    run({ IDEA_HOSTNAME: 'idea03', IDEA_HOST_IPS: '10.99.0.13' })
    assert.deepEqual(td(), ['localhost', 'idea03', 'idea03.local', '10.99.0.13', 'cloud.school.example'])
    run({ IDEA_HOSTNAME: 'idea04', IDEA_HOST_IPS: '10.99.0.14' })
    assert.deepEqual(td(), ['localhost', 'idea04', 'idea04.local', '10.99.0.14', 'cloud.school.example'])
    assert.ok(!managed().includes('cloud.school.example'))
  })

  it('empty env: logs and leaves the config untouched (fail open)', () => {
    setState({ system: { trusted_domains: ['idea01:18280'] } })
    for (const env of [{}, { IDEA_HOSTNAME: '', IDEA_HOST_IPS: '' }, { IDEA_HOSTNAME: ' ', IDEA_HOST_IPS: ' , ' }]) {
      const r = run(env)
      assert.match(r.stdout, /empty — trusted_domains left unchanged/)
    }
    assert.deepEqual(td(), ['idea01:18280'])
    assert.deepEqual(writes(), [])
  })

  it('hostname only or IPs only; .local suffix and non-IPv4 values handled; localhost always kept', () => {
    setState({ system: {} })
    run({ IDEA_HOSTNAME: 'idea05.local' })
    assert.deepEqual(td(), ['localhost', 'idea05', 'idea05.local'])
    setState({ system: { trusted_domains: ['other'] } })
    const r = run({ IDEA_HOST_IPS: ' 10.0.0.5 , fe80::1,10.0.0.5:8080,10.0.0.6' })
    assert.deepEqual(td(), ['localhost', '10.0.0.5', '10.0.0.6', 'other'])
    assert.match(r.stdout, /ignoring 'fe80::1'/)
    assert.match(r.stdout, /ignoring '10.0.0.5:8080'/)
  })

  it('occ not ready or a failing set: exits 0 and never empties trusted_domains', () => {
    setState({ ready: false, system: { trusted_domains: ['idea01:18280'] } })
    assert.match(run({ IDEA_HOSTNAME: 'idea03' }).stdout, /occ not ready/)
    setState({ failSet: true, system: { trusted_domains: ['idea01:18280'] } })
    assert.match(run({ IDEA_HOSTNAME: 'idea03' }).stdout, /WARNING/)
    assert.deepEqual(td(), ['idea01:18280'])
  })

  it('wildcard admin entries stay literal (no glob expansion, even with matching files in cwd)', () => {
    // Files that *.example.com and idea0? would match if the hook expanded globs
    writeFileSync(join(dir, 'a.example.com'), '')
    writeFileSync(join(dir, 'idea09'), '')
    setState({ system: { trusted_domains: ['localhost', '*.example.com', 'idea0?'] } })
    run({ IDEA_HOSTNAME: 'idea03', IDEA_HOST_IPS: '10.99.0.13' }, dir)
    assert.deepEqual(td(), ['localhost', 'idea03', 'idea03.local', '10.99.0.13', '*.example.com', 'idea0?'])
    run({ IDEA_HOSTNAME: 'idea01', IDEA_HOST_IPS: '10.99.0.11' }, dir)
    assert.deepEqual(td(), ['localhost', 'idea01', 'idea01.local', '10.99.0.11', '*.example.com', 'idea0?'])
  })

  it('invalid IDEA_HOSTNAME is logged and ignored; the IPs are still applied', () => {
    for (const bad of ['-idea03', 'idea03-', 'idea_03', 'id ea;rm', '*', 'idea03/x']) {
      setState({ system: { trusted_domains: ['localhost'] } })
      const r = run({ IDEA_HOSTNAME: bad, IDEA_HOST_IPS: '10.99.0.13' })
      assert.match(r.stdout, /ignoring IDEA_HOSTNAME/, bad)
      assert.deepEqual(td(), ['localhost', '10.99.0.13'], bad)
    }
    setState({ system: { trusted_domains: ['idea01:18280'] } })
    const r = run({ IDEA_HOSTNAME: '-bad' })
    assert.match(r.stdout, /ignoring IDEA_HOSTNAME/)
    assert.deepEqual(td(), ['idea01:18280'], 'invalid hostname and no IPs: config untouched')
    setState({ system: {} })
    run({ IDEA_HOSTNAME: 'idea-03.lan' })
    assert.deepEqual(td(), ['localhost', 'idea-03.lan', 'idea-03.lan.local'])
  })

  it('shrinking by 2 or more: stale entries deleted from the highest index down, no holes (real occ delete semantics)', () => {
    setState({ system: { trusted_domains: ['localhost'] } })
    run({ IDEA_HOSTNAME: 'idea01', IDEA_HOST_IPS: '10.99.0.11,10.98.0.11,100.64.0.11' })
    assert.equal(td().length, 6)
    setState({ ...state(), calls: [] })
    run({ IDEA_HOSTNAME: 'idea03' })
    const raw = state().system.trusted_domains
    assert.deepEqual(raw, ['localhost', 'idea03', 'idea03.local'], `no holes: ${JSON.stringify(raw)}`)
    assert.deepEqual(state().system.idea_trusted_domains_managed, ['idea03', 'idea03.local'])
    const dels = state().calls.filter(c => c[0] === 'config:system:delete' && c[1] === 'trusted_domains').map(c => Number(c[2]))
    assert.deepEqual(dels, [5, 4, 3])
  })
})
