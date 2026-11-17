/**
 * engine#456 (draft): the x-app.update declaration in compose.yaml and the step
 * scripts it points at. Mirrors the Engine contract in the #456 issue body:
 * prepare / verify / work = { service, user?, command, timeout },
 * settle = { service, user?, command, interval, timeout }; command is one
 * absolute path; service is a compose service.
 * Also shellchecks the step scripts when shellcheck is installed, and runs
 * agent-app-dev check-compose (gap 12 rules) when AAD_CHECK_COMPOSE is set.
 * Run: node --test tests/
 */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const compose = readFileSync(join(root, 'compose.yaml'), 'utf8')
const lines = compose.split('\n')

// The two-space `  update:` block under x-app, up to the next two-space key.
const updateBlock = () => {
  const start = lines.indexOf('  update:')
  assert.ok(start > 0, 'x-app.update block missing')
  const out = []
  for (const l of lines.slice(start + 1)) {
    if (/^  \S/.test(l) || /^\S/.test(l)) break
    out.push(l)
  }
  return out
}
const stages = () => {
  const s = {}
  let cur
  for (const l of updateBlock()) {
    let m
    if ((m = l.match(/^    (\w+):\s*$/))) { cur = m[1]; s[cur] = {}; continue }
    if ((m = l.match(/^      (\w+):\s*(.+?)\s*$/)) && cur) s[cur][m[1]] = m[2].replace(/^"(.*)"$/, '$1')
  }
  return s
}
const XVER = compose.match(/^  version: "([^"]+)"$/m)[1]

it('declares exactly prepare, verify, work, settle with the contract fields', () => {
  const s = stages()
  assert.deepEqual(Object.keys(s), ['prepare', 'verify', 'work', 'settle'])
  for (const [name, st] of Object.entries(s)) {
    const want = name === 'settle'
      ? ['service', 'user', 'command', 'interval', 'timeout']
      : ['service', 'user', 'command', 'timeout']
    assert.deepEqual(Object.keys(st), want, name)
    assert.equal(st.service, 'nextcloud-app', name)
    assert.match(compose, new RegExp(`^  ${st.service}:$`, 'm'), `${name}: service not in compose`)
    assert.match(st.command, /^\/idea\/hooks\/[\w.-]+\.sh$/, `${name}: command must be one absolute path`)
    assert.match(st.timeout, /^[1-9]\d*$/, `${name}: timeout`)
    if (name === 'settle') {
      assert.match(st.interval, /^[1-9]\d*$/)
      assert.ok(Number(st.interval) < Number(st.timeout))
    }
  }
})

it('prepare runs as root (chown 33); every occ / cron step declares user "33" (Engine never defaults it)', () => {
  const s = stages()
  assert.equal(s.prepare.user, '0')
  for (const n of ['verify', 'work', 'settle']) assert.equal(s[n].user, '33', n)
  // Quoted in the YAML so the Engine sees a string, not a number.
  for (const l of updateBlock().filter(l => /^      user:/.test(l))) assert.match(l, /user: "\d+"$/)
})

it('timeouts: prepare 600, verify 120, work 3600, settle interval 60 / timeout 3600', () => {
  const s = stages()
  assert.equal(s.prepare.timeout, '600')
  assert.equal(s.verify.timeout, '120')
  assert.equal(s.work.timeout, '3600')
  assert.equal(s.settle.interval, '60')
  assert.equal(s.settle.timeout, '3600')
})

it('every step command is an executable script in hooks/, visible through the whole-dir mount', () => {
  assert.match(compose, /^      - \.\/hooks:\/idea\/hooks:ro$/m)
  for (const [name, st] of Object.entries(stages())) {
    const host = join(root, 'hooks', st.command.replace('/idea/hooks/', ''))
    assert.ok(existsSync(host), `${name}: ${host} missing`)
    assert.ok(statSync(host).mode & 0o111, `${name}: ${host} not executable`)
    assert.match(readFileSync(host, 'utf8'), /^#!\/bin\/sh\n/, `${name}: POSIX sh (the image has no bash guarantee)`)
  }
  for (const f of ['update-lib.sh', 'appstore-pin.php']) assert.ok(existsSync(join(root, 'hooks', f)), f)
})

it('IDEA_APP_VERSION matches x-app.version and hooks/update-targets has that row, matching the bundled tarballs', () => {
  assert.match(compose, new RegExp(`^      - IDEA_APP_VERSION=${XVER.replace(/\./g, '\\.')}$`, 'm'))
  const row = readFileSync(join(root, 'hooks/update-targets'), 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#')).map(l => l.split(/\s+/)).find(c => c[0] === XVER)
  assert.ok(row, `no update-targets row for ${XVER}`)
  const tgz = readdirSync(join(root, 'bundled-apps'))
  assert.ok(tgz.includes(`richdocuments-v${row[1]}.tar.gz`), `richdocuments ${row[1]} not bundled`)
  assert.ok(tgz.includes(`idea_usage-v${row[2]}.tar.gz`), `idea_usage ${row[2]} not bundled`)
})

it('the block is marked as a draft pending the #456 runner (interim Engines refuse it)', () => {
  assert.match(compose, /DRAFT \(engine#456/)
  assert.match(compose, /UPDATE_STAGES_UNSUPPORTED/)
})

const HAS_SC = spawnSync('shellcheck', ['--version']).status === 0
it('shellcheck: step scripts are clean (sh, following sourced update-lib.sh)', { skip: !HAS_SC && 'shellcheck not installed' }, () => {
  const scripts = ['update-lib.sh', ...new Set(Object.values(stages()).map(s => s.command.replace('/idea/hooks/', '')))]
  const r = spawnSync('shellcheck', ['-s', 'sh', '-x', '-P', join(root, 'hooks'), ...scripts.map(f => join(root, 'hooks', f))], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

const CC = process.env.AAD_CHECK_COMPOSE
it('agent-app-dev check-compose accepts the compose (gap 12 x-app.update rules)', { skip: !CC && 'AAD_CHECK_COMPOSE not set' }, () => {
  const r = spawnSync('node', [CC, join(root, 'compose.yaml')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
