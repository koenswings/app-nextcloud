/**
 * Unit tests for hooks/verify-update.sh. No Docker: fake curl + OCC.
 * Exit 0 passes; any other exit is VERIFY_FAILED (rollback). No "not yet".
 * Versions come from bundled tarballs unless overridden, so the same tests
 * serve 2.0 / 3.0 / 4.0.
 * Run: node --test tests/
 */
import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(root, 'hooks/verify-update.sh')
const BUNDLED = join(root, 'bundled-apps')
const rdTarball = readdirSync(BUNDLED).find(f => /^richdocuments-v.+\.tar\.gz$/.test(f))
const usageTarball = readdirSync(BUNDLED).find(f => /^idea_usage-v.+\.tar\.gz$/.test(f))
const RD_VER = rdTarball.match(/^richdocuments-v(.+)\.tar\.gz$/)[1]
const USAGE_VER = usageTarball.match(/^idea_usage-v(.+)\.tar\.gz$/)[1]
const READY = '{"installed":true,"maintenance":false,"needsDbUpgrade":false,"version":"x"}'
const MAINT = '{"installed":true,"maintenance":true,"needsDbUpgrade":false}'
const NEEDDB = '{"installed":true,"maintenance":false,"needsDbUpgrade":true}'
const NOTINST = '{"installed":false,"maintenance":false,"needsDbUpgrade":false}'
const appList = (rd = RD_VER, usage = USAGE_VER, rdEnabled = true, usageEnabled = true) => {
  const enabled = []
  const disabled = []
  if (rdEnabled) enabled.push(`  - richdocuments: ${rd}`)
  else disabled.push(`  - richdocuments: ${rd}`)
  if (usageEnabled) enabled.push(`  - idea_usage: ${usage}`)
  else disabled.push(`  - idea_usage: ${usage}`)
  return `Enabled:\n  - activity: 4.0.0\n${enabled.join('\n')}\nDisabled:\n${disabled.join('\n')}\n`
}
let dir, bin, occ

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idea-verify-'))
  bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) shift 2 ;;
    -s|-S|-sS|-m) [ "$1" = -m ] && shift 2 || shift ;;
    -m) shift 2 ;;
    http*|https*) shift ;;
    *) shift ;;
  esac
done
[ "$IDEA_CURL_FAIL" = 1 ] && exit 7
[ -n "$out" ] && printf '%s' "$IDEA_HC_BODY" > "$out"
printf '%s' "\${IDEA_HC_CODE:-200}"
exit 0
`)
  spawnSync('chmod', ['755', join(bin, 'curl')])
  occ = join(dir, 'occ')
  writeFileSync(occ, `#!/bin/sh
if [ "$IDEA_OCC_FAIL" = 1 ]; then exit 1; fi
printf '%s' "$IDEA_OCC_LIST"
exit 0
`)
  spawnSync('chmod', ['755', occ])
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const run = (env = {}, args = []) => spawnSync(SCRIPT, args, {
  encoding: 'utf8',
  env: {
    PATH: `${bin}:${process.env.PATH}`,
    OCC: occ,
    IDEA_NC_HEALTH_URL: 'http://127.0.0.1/status.php',
    IDEA_HC_BODY: READY,
    IDEA_OCC_LIST: appList(),
    IDEA_BUNDLED_APPS: BUNDLED,
    ...env,
  },
})

it(`exit 0 when status.php is ready and richdocuments ${RD_VER} plus idea_usage ${USAGE_VER} are enabled`, () => {
  const r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /verified/)
  assert.match(r.stdout, new RegExp(`richdocuments ${RD_VER.replace(/\./g, '\\.')}`))
})

it('reads the target version from the bundled tarball when env is unset', () => {
  const r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

it('reads the target version from update-targets when IDEA_APP_VERSION is set and no tarball dir is visible', () => {
  const r = run({
    IDEA_BUNDLED_APPS: join(dir, 'missing-bundled'),
    IDEA_APP_VERSION: '4.0-34.0.6',
    IDEA_OCC_LIST: appList('11.1.3', '1.0.0'),
  })
  // On a 2.0/3.0 tree this still works: we force 4.0-34.0.6 + matching app list.
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

it('exit 1 (not 3) when status.php is unreachable, in maintenance, or needs a DB upgrade', () => {
  let r = run({ IDEA_CURL_FAIL: '1' })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /ERROR: status.php unreachable/)
  r = run({ IDEA_HC_CODE: '503', IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /ERROR: status.php HTTP 503/)
  r = run({ IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /ERROR: status.php maintenance is not false/)
  r = run({ IDEA_HC_BODY: NEEDDB })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /ERROR: status.php needsDbUpgrade is not false/)
})

it('exit 1 when installed is false, an app is missing or disabled, or richdocuments is the wrong version', () => {
  let r = run({ IDEA_HC_BODY: NOTINST })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /installed is not true/)
  r = run({ IDEA_OCC_LIST: appList(RD_VER, USAGE_VER, false, true) })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, new RegExp(`richdocuments >= ${RD_VER.replace(/\./g, '\\.')} is not enabled`))
  r = run({ IDEA_OCC_LIST: appList('0.0.1', USAGE_VER, true, true) })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, new RegExp(`richdocuments 0\\.0\\.1 is older than the pinned ${RD_VER.replace(/\./g, '\\.')}`))
  r = run({ IDEA_OCC_LIST: appList(RD_VER, USAGE_VER, true, false) })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /idea_usage is not enabled|idea_usage .+ is not enabled/)
})

it('exit 1 when occ app:list fails (verify runs once, so this is a hard failure)', () => {
  const r = run({ IDEA_OCC_FAIL: '1' })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /ERROR: occ app:list failed/)
})

it('refuses leftover argv', () => {
  const r = run({}, ['apache2-foreground'])
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /ERROR: unexpected arguments: apache2-foreground/)
})

// Steve's decision 2026-11-16 (Axle review §#456 L (b)): richdocuments at the pinned
// version OR NEWER passes, by semver compare, not string compare.
const bump = (v, i) => v.split('.').map((x, j) => j === i ? String(Number(x) + 1) : (j > i ? '0' : x)).join('.')
const down = (v) => {
  const p = v.split('.').map(Number)
  for (let i = p.length - 1; i >= 0; i--) { if (p[i] > 0) { p[i] -= 1; return p.join('.') } }
  return null
}

it('richdocuments newer than the pin passes (patch, minor and major bumps) and says so', () => {
  for (const v of [bump(RD_VER, 2), bump(RD_VER, 1), bump(RD_VER, 0)]) {
    const r = run({ IDEA_OCC_LIST: appList(v, USAGE_VER) })
    assert.equal(r.status, 0, v + ': ' + r.stdout + r.stderr)
    assert.match(r.stdout, new RegExp(`richdocuments ${v.replace(/\./g, '\\.')} is newer than the pinned`))
    assert.match(r.stdout, /verified/)
  }
})

it('compares numerically, not as strings: pin 9.2.3 accepts 9.10.0 and 10.0.0, refuses 9.2.2 and 9.1.10', () => {
  const env = { IDEA_VERIFY_RICHDOCUMENTS_VERSION: '9.2.3', IDEA_VERIFY_IDEA_USAGE_VERSION: USAGE_VER }
  for (const v of ['9.2.3', '9.2.10', '9.10.0', '10.0.0']) {
    const r = run({ ...env, IDEA_OCC_LIST: appList(v, USAGE_VER) })
    assert.equal(r.status, 0, v + ': ' + r.stdout + r.stderr)
  }
  for (const v of ['9.2.2', '9.1.10', '8.99.99', '9.2.3-beta.1']) {
    const r = run({ ...env, IDEA_OCC_LIST: appList(v, USAGE_VER) })
    assert.equal(r.status, 1, v + ': ' + r.stdout + r.stderr)
    assert.match(r.stdout, /is older than the pinned 9\.2\.3/)
  }
})

it('richdocuments older than the pin fails (VERIFY_FAILED)', () => {
  const v = down(RD_VER)
  const r = run({ IDEA_OCC_LIST: appList(v, USAGE_VER) })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /ERROR: richdocuments .* is older than the pinned/)
})

it('a newer richdocuments that is disabled still fails', () => {
  const r = run({ IDEA_OCC_LIST: appList(bump(RD_VER, 1), USAGE_VER, false, true) })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /richdocuments >= .* is not enabled/)
})

it('a non-version richdocuments string fails rather than passing a string compare', () => {
  const r = run({ IDEA_OCC_LIST: appList('master', USAGE_VER) })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /is not a version/)
})

it('idea_usage keeps the exact-version check (a newer idea_usage fails)', () => {
  const r = run({ IDEA_OCC_LIST: appList(RD_VER, bump(USAGE_VER, 2)) })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, new RegExp(`idea_usage ${USAGE_VER.replace(/\./g, '\\.')} is not enabled`))
})

it('idea_usage version is matched literally (dots are not wildcards)', () => {
  const fake = USAGE_VER.replace(/\./g, 'x')
  const r = run({ IDEA_OCC_LIST: appList(RD_VER, fake) })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /idea_usage .+ is not enabled/)
})
