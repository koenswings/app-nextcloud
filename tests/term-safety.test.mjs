/**
 * engine#456: TERM safety of the x-app.update step scripts. On a step timeout the
 * Engine sends SIGTERM to the in-container pid, then SIGKILL after 10 s. Each test
 * interrupts a run (TERM through the trap, or KILL with no trap at all) at a named
 * point, checks nothing is half-written, then reruns and checks the end state.
 * Also: ERROR: / not yet: lines start at column 0 (the Engine matches them only at
 * the start of a line). No Docker. Run: node --test tests/
 */
import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, readdirSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const H = (f) => join(root, 'hooks', f)
const PREP = H('prep-custom-apps-for-upgrade.sh')
const PIN = H('appstore-pin.php')
const BUNDLED = join(root, 'bundled-apps')
const rdTarball = readdirSync(BUNDLED).find(f => /^richdocuments-v.+\.tar\.gz$/.test(f))
const usageTarball = readdirSync(BUNDLED).find(f => /^idea_usage-v.+\.tar\.gz$/.test(f))
const RD_VER = rdTarball.match(/^richdocuments-v(.+)\.tar\.gz$/)[1]
const HAS_PHP = spawnSync('php', ['-v']).status === 0
let dir, src, dst, cfg, tmp

const writeInfo = (appDir, version, max) => {
  mkdirSync(join(appDir, 'appinfo'), { recursive: true })
  writeFileSync(join(appDir, 'appinfo/info.xml'),
    `<?xml version="1.0"?>\n<info>\n  <version>${version}</version>\n  <dependencies><nextcloud min-version="20" max-version="${max}"/></dependencies>\n</info>\n`)
}
const CONFIG = "<?php\n$CONFIG = array (\n  'instanceid' => 'oc123',\n  'version' => '31.0.14.1',\n  'installed' => true,\n);\n"

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idea-term-'))
  src = join(dir, 'bundled-apps')
  dst = join(dir, 'data/nextcloud/custom_apps')
  tmp = join(dir, 'tmp')
  for (const d of [src, dst, tmp, join(dir, 'data/nextcloud/config')]) mkdirSync(d, { recursive: true })
  cfg = join(dir, 'data/nextcloud/config/config.php')
  writeFileSync(cfg, CONFIG, { mode: 0o640 })
  for (const f of [usageTarball, rdTarball, 'SHA256SUMS']) cpSync(join(BUNDLED, f), join(src, f))
  writeInfo(join(dst, 'richdocuments'), '0.0.1', '20')
  writeFileSync(join(dst, 'richdocuments/OLD'), 'old')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const prepEnv = (extra = {}) => ({ PATH: process.env.PATH, TMPDIR: tmp, IDEA_BUNDLED_APPS: src, IDEA_CUSTOM_APPS: dst, IDEA_NC_CONFIG: cfg, ...extra })
const prep = (extra = {}) => spawnSync(PREP, [], { encoding: 'utf8', env: prepEnv(extra) })
const dotLeftovers = () => readdirSync(dst).filter(n => /^\.idea-prep-/.test(n))
const rdVersion = () => readFileSync(join(dst, 'richdocuments/appinfo/info.xml'), 'utf8').match(/<version>([^<]+)</)[1]
const assertFinal = () => {
  assert.equal(rdVersion(), RD_VER)
  assert.ok(existsSync(join(dst, 'idea_usage/appinfo/info.xml')))
  assert.deepEqual(dotLeftovers(), [])
  assert.deepEqual(readdirSync(join(dir, 'data/nextcloud/config')), ['config.php'])
  assert.ok(readdirSync(join(dst, '.idea-upgrade-backup')).some(n => n.startsWith('richdocuments-0.0.1-')))
  assert.ok(existsSync(join(dst, '.idea-update-state/appstoreenabled.state')))
  if (HAS_PHP) assert.match(readFileSync(cfg, 'utf8'), /'appstoreenabled' => false/)
  assert.equal(statSync(cfg).mode & 0o777, 0o640)
}

for (const sig of ['KILL', 'TERM']) {
  it(`prepare killed (${sig}) right after moving the old tree aside: no custom_apps/richdocuments, rerun extracts it`, { skip: !HAS_PHP }, () => {
    const r = prep({ IDEA_PREP_TEST_KILL_AT: `after-backup:${sig}` })
    assert.notEqual(r.status, 0)
    if (sig === 'TERM') {
      assert.equal(r.status, 143, r.stdout + r.stderr)
      assert.match(r.stdout, /^ERROR: interrupted by SIGTERM \(rerun resumes\) \[idea-prep-custom-apps\]$/m)
      assert.deepEqual(dotLeftovers(), [], 'the TERM trap removes the plan / info temp files')
    }
    assert.equal(r.signal ?? null, sig === 'KILL' ? 'SIGKILL' : null)
    assert.ok(!existsSync(join(dst, 'richdocuments')) || rdVersion() === '0.0.1')
    assert.equal(readFileSync(cfg, 'utf8'), CONFIG, 'config.php untouched before the pin')
    const again = prep()
    assert.equal(again.status, 0, again.stdout + again.stderr)
    assertFinal()
  })

  it(`prepare killed (${sig}) after extracting into staging, before the rename into place: rerun moves the staging aside and finishes`, { skip: !HAS_PHP }, () => {
    const r = prep({ IDEA_PREP_TEST_KILL_AT: `after-extract:${sig}` })
    assert.notEqual(r.status, 0)
    assert.ok(dotLeftovers().some(n => n.startsWith('.idea-prep-staging-')), 'a staging dir is left behind')
    const again = prep()
    assert.equal(again.status, 0, again.stdout + again.stderr)
    assert.match(again.stdout, /moved interrupted staging \.idea-prep-staging-/)
    if (sig === 'KILL') assert.match(again.stdout, /removed stale \.idea-prep-plan-/)
    assertFinal()
    assert.ok(readdirSync(join(dst, '.idea-upgrade-backup')).some(n => /^idea-prep-staging-.*-interrupted-/.test(n)), 'moved, never deleted')
  })
}

it('prepare killed before the pin: rerun skips the staged apps and pins with the real previous value', { skip: !HAS_PHP }, () => {
  writeFileSync(cfg, CONFIG.replace("  'installed' => true,\n", "  'installed' => true,\n  'appstoreenabled' => true,\n"), { mode: 0o640 })
  const r = prep({ IDEA_PREP_TEST_KILL_AT: 'before-pin:KILL' })
  assert.equal(r.signal, 'SIGKILL')
  assert.equal(rdVersion(), RD_VER)
  assert.ok(!existsSync(join(dst, '.idea-update-state/appstoreenabled.state')))
  const again = prep()
  assert.equal(again.status, 0, again.stdout + again.stderr)
  assert.match(again.stdout, /richdocuments already at/)
  assert.match(readFileSync(join(dst, '.idea-update-state/appstoreenabled.state'), 'utf8'), /^previous=bool:true$/m)
})

for (const point of ['state-tmp', 'config-tmp']) {
  it(`appstore-pin dies at ${point} (temp written, not renamed): target files are whole; rerun removes the temp and pins`, { skip: !HAS_PHP }, () => {
    const stateDir = join(dst, '.idea-update-state')
    mkdirSync(stateDir)
    const state = join(stateDir, 'appstoreenabled.state')
    const r = spawnSync('php', [PIN, cfg, state], { encoding: 'utf8', env: { PATH: process.env.PATH, IDEA_PIN_TEST_DIE_AT: point } })
    assert.equal(r.status, 137, r.stdout + r.stderr)
    assert.equal(readFileSync(cfg, 'utf8'), CONFIG, 'config.php is never partial')
    if (point === 'state-tmp') {
      assert.ok(!existsSync(state))
      assert.ok(readdirSync(stateDir).some(n => n.startsWith('appstoreenabled.state.tmp-')))
    } else {
      assert.match(readFileSync(state, 'utf8'), /^previous=unset$/m)
      assert.ok(readdirSync(join(dir, 'data/nextcloud/config')).some(n => n.startsWith('.config.php.idea-tmp-')))
    }
    const again = spawnSync('php', [PIN, cfg, state], { encoding: 'utf8', env: { PATH: process.env.PATH } })
    assert.equal(again.status, 0, again.stdout + again.stderr)
    assert.match(again.stdout, /removed stale temp file/)
    assert.deepEqual(readdirSync(join(dir, 'data/nextcloud/config')), ['config.php'])
    assert.deepEqual(readdirSync(stateDir), ['appstoreenabled.state'])
    assert.match(readFileSync(state, 'utf8'), /^previous=unset$/m)
    assert.match(readFileSync(cfg, 'utf8'), /'appstoreenabled' => false/)
    assert.equal(statSync(cfg).mode & 0o777, 0o640)
  })
}

// ---- exec steps: TERM forwarded to the running child, temp files removed ----

const waitFor = async (file, ms = 5000) => {
  const t0 = Date.now()
  while (!existsSync(file)) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${file}`)
    await new Promise(r => setTimeout(r, 25))
  }
}
const runAsync = (script, env) => new Promise(resolve => {
  const p = spawn(script, [], { env })
  let out = ''
  p.stdout.on('data', d => { out += d })
  p.stderr.on('data', d => { out += d })
  p.on('exit', (code, signal) => resolve({ code, signal, out }))
  runAsync.last = p
})
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

it('work: SIGTERM during cron.php stops cron at once, prints one ERROR: line, exits 143; a rerun completes', async () => {
  const marker = join(dir, 'cron-pid')
  const cron = join(dir, 'cron')
  writeFileSync(cron, `#!/bin/sh\nif [ -n "$IDEA_SLOW" ]; then echo $$ > "${marker}"; exec sleep 30; fi\nexit 0\n`, { mode: 0o755 })
  const occ = join(dir, 'occ')
  writeFileSync(occ, '#!/bin/sh\ncase "$1" in background-job:list) echo "  3  OCA\\\\Foo\\\\Job  1  []" ;; esac\nexit 0\n', { mode: 0o755 })
  const env = { PATH: process.env.PATH, TMPDIR: tmp, OCC: occ, IDEA_CRON: cron, IDEA_UPDATE_STATE_DIR: join(dir, 'no-state') }
  const done = runAsync(H('work-update.sh'), { ...env, IDEA_SLOW: '1' })
  const p = runAsync.last
  await waitFor(marker)
  const cronPid = Number(readFileSync(marker, 'utf8'))
  const t0 = Date.now()
  p.kill('SIGTERM')
  const r = await done
  assert.ok(Date.now() - t0 < 3000, 'trap fired while cron was still running')
  assert.equal(r.code, 143, r.out)
  assert.match(r.out, /^ERROR: interrupted by SIGTERM \[idea-work-update\]$/m)
  await new Promise(res => setTimeout(res, 200))
  assert.ok(!alive(cronPid), 'cron.php child was stopped')
  assert.deepEqual(readdirSync(tmp), [])
  const again = spawnSync(H('work-update.sh'), [], { encoding: 'utf8', env })
  assert.equal(again.status, 0, again.stdout + again.stderr)
  assert.match(again.stdout, /work done/)
})

for (const [name, script] of [['verify', 'verify-update.sh'], ['settle', 'settle-update.sh']]) {
  it(`${name}: SIGTERM while waiting on status.php removes its temp file and exits 143 with an ERROR: line`, async () => {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const marker = join(dir, 'curl-started')
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\n: > "${marker}"\nsleep 1\nexit 7\n`, { mode: 0o755 })
    const env = { PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp, IDEA_BUNDLED_APPS: BUNDLED, OCC: '/bin/false' }
    const done = runAsync(H(script), env)
    const p = runAsync.last
    await waitFor(marker)
    assert.equal(readdirSync(tmp).length, 1, 'one temp file while running')
    p.kill('SIGTERM')
    const r = await done
    assert.equal(r.code, 143, r.out)
    assert.match(r.out, new RegExp(`^ERROR: interrupted by SIGTERM \\[idea-${name}-update\\]$`, 'm'))
    assert.deepEqual(readdirSync(tmp), [], 'temp file removed by the trap')
  })
}

// ---- (A) line format: ERROR: / not yet: at the start of the line ----

it('ERROR: and not yet: lines start at column 0 and name the script at the end', () => {
  const base = { PATH: process.env.PATH, TMPDIR: tmp, IDEA_NC_HEALTH_URL: 'http://127.0.0.1:9/status.php', IDEA_BUNDLED_APPS: BUNDLED, OCC: '/bin/false' }
  const v = spawnSync(H('verify-update.sh'), [], { encoding: 'utf8', env: base })
  assert.equal(v.status, 1)
  assert.match(v.stdout, /^ERROR: status\.php unreachable \[idea-verify-update\]$/m)
  const s = spawnSync(H('settle-update.sh'), [], { encoding: 'utf8', env: base })
  assert.equal(s.status, 3)
  assert.match(s.stdout, /^not yet: status\.php unreachable \[idea-settle-update\]$/m)
  const w = spawnSync(H('work-update.sh'), [], { encoding: 'utf8', env: { ...base, IDEA_WORK_SCHEMA_REPAIR: 'x', IDEA_UPDATE_STATE_DIR: join(dir, 'none') } })
  assert.equal(w.status, 1)
  assert.match(w.stdout, /^ERROR: IDEA_WORK_SCHEMA_REPAIR must be 0 or 1 \(got x\) \[idea-work-update\]$/m)
  const pr = spawnSync(PREP, ['apache2-foreground'], { encoding: 'utf8', env: base })
  assert.equal(pr.status, 1)
  assert.match(pr.stdout, /^ERROR: unexpected arguments: apache2-foreground .* \[idea-prep-custom-apps\]$/m)
  // No step prints a prefixed ERROR / not yet (the Engine would miss it).
  for (const f of ['update-lib.sh', 'prep-custom-apps-for-upgrade.sh', 'verify-update.sh', 'work-update.sh', 'settle-update.sh', 'appstore-pin.php']) {
    const code = readFileSync(H(f), 'utf8').split('\n').filter(l => !/^\s*(#|\/\/)/.test(l)).join('\n')
    assert.doesNotMatch(code, /(idea_log|log|out)\(?\s*"(ERROR|not yet):/, f)
  }
})
