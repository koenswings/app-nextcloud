/**
 * app-nextcloud#29: nextcloud-app Docker healthcheck. Run: node --test tests/
 */
import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(root, 'hooks/app-healthcheck.sh')
const compose = readFileSync(join(root, 'compose.yaml'), 'utf8')
const READY = '{"installed":true,"maintenance":false,"needsDbUpgrade":false}'
const MAINT = '{"installed":true,"maintenance":true,"needsDbUpgrade":false}'
let dir, bin, marker

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idea-nc-hc-'))
  bin = join(dir, 'bin'); mkdirSync(bin)
  marker = join(dir, '.idea-backup-pending')
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w|-m) shift 2 ;;
    -s|-S|-sS|-f|-fsS) shift ;;
    -*) shift ;;
    *) shift ;;
  esac
done
[ "$IDEA_HC_FAIL" = 1 ] && exit 7
[ -n "$out" ] && printf '%s' "$IDEA_HC_BODY" > "$out"
printf '%s' "\${IDEA_HC_CODE:-200}"
exit 0
`)
  chmodSync(join(bin, 'curl'), 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const run = (env = {}) => spawnSync(SCRIPT, [], { encoding: 'utf8',
  env: { PATH: `${bin}:${process.env.PATH}`, IDEA_NC_HEALTH_URL: 'http://127.0.0.1/status.php',
    IDEA_BACKUP_MARKER: marker, ...env } })

it('compose: app healthcheck script, interval/retries unchanged, x-app.healthCheck stays strict', () => {
  assert.match(compose, /test: \["CMD", "\/idea\/app-healthcheck\.sh"\]/)
  assert.match(compose, /interval: 15s\n      timeout: 5s\n      retries: 3\n      start_period: 300s/)
  assert.match(compose, /- \.\/hooks\/app-healthcheck\.sh:\/idea\/app-healthcheck\.sh:ro/)
  assert.match(compose, /healthCheck:\n    path: \/status\.php\n    expect: '"maintenance":false,"needsDbUpgrade":false'/)
  assert.doesNotMatch(compose, /curl -fsS -m 4 http:\/\/127\.0\.0\.1\/status\.php/)
})

it('healthy: HTTP 200 with maintenance false and needsDbUpgrade false', () => {
  const r = run({ IDEA_HC_CODE: '200', IDEA_HC_BODY: READY })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(r.stdout, '')
})

it('maintenance with a fresh backup marker: HTTP 503 with maintenance true is alive', () => {
  writeFileSync(marker, '')
  const r = run({ IDEA_HC_CODE: '503', IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(r.stdout, '')
})

it('Nextcloud 31: HTTP 200 with maintenance true and a fresh marker is alive (idea03 2026-11-15)', () => {
  writeFileSync(marker, '')
  const r = run({ IDEA_HC_CODE: '200', IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(r.stdout, '')
})

it('Nextcloud 31: HTTP 200 with maintenance true and no marker, a stale marker, or a far-future marker is unhealthy', () => {
  let r = run({ IDEA_HC_CODE: '200', IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 1, 'no marker: ' + r.stdout + r.stderr)
  writeFileSync(marker, '')
  const now = Date.now() / 1000
  utimesSync(marker, now - 3 * 3600, now - 3 * 3600)
  r = run({ IDEA_HC_CODE: '200', IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 1, '3 h old: ' + r.stdout + r.stderr)
  utimesSync(marker, now + 3600, now + 3600)
  r = run({ IDEA_HC_CODE: '200', IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 1, '+1 h future: ' + r.stdout + r.stderr)
})

it('maintenance with a marker older than 2 h is unhealthy', () => {
  writeFileSync(marker, '')
  const past = Date.now() / 1000 - 3 * 3600
  utimesSync(marker, past, past)
  const r = run({ IDEA_HC_CODE: '503', IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 1, r.stdout + r.stderr)
})

it('boundary: a marker aged 7190 s (just under 2 h) is alive; 7210 s (just over) is not', () => {
  writeFileSync(marker, '')
  const now = Date.now() / 1000
  utimesSync(marker, now - 7190, now - 7190)
  let r = run({ IDEA_HC_CODE: '503', IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 0, 'just under 2 h should still be fresh: ' + r.stdout + r.stderr)
  utimesSync(marker, now - 7210, now - 7210)
  r = run({ IDEA_HC_CODE: '503', IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 1, 'just over 2 h should be stale: ' + r.stdout + r.stderr)
})

it('a future mtime within 300 s counts as fresh (small backward clock skew)', () => {
  writeFileSync(marker, '')
  const now = Date.now() / 1000
  utimesSync(marker, now + 60, now + 60)
  const r = run({ IDEA_HC_CODE: '503', IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

it('a future mtime beyond 300 s is stale (unbounded future would hide stuck maintenance)', () => {
  writeFileSync(marker, '')
  const now = Date.now() / 1000
  utimesSync(marker, now + 3600, now + 3600)
  const r = run({ IDEA_HC_CODE: '503', IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 1, r.stdout + r.stderr)
})

it('boundary: a marker 290 s in the future is alive; 310 s in the future is not', () => {
  writeFileSync(marker, '')
  const now = Date.now() / 1000
  utimesSync(marker, now + 290, now + 290)
  let r = run({ IDEA_HC_CODE: '503', IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 0, '290 s in the future should still be fresh: ' + r.stdout + r.stderr)
  utimesSync(marker, now + 310, now + 310)
  r = run({ IDEA_HC_CODE: '503', IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 1, '310 s in the future should be stale: ' + r.stdout + r.stderr)
})

it('IDEA_BACKUP_MARKER_MAX_AGE_S shortens the bound', () => {
  writeFileSync(marker, '')
  const past = Date.now() / 1000 - 30
  utimesSync(marker, past, past)
  let r = run({ IDEA_HC_CODE: '503', IDEA_HC_BODY: MAINT, IDEA_BACKUP_MARKER_MAX_AGE_S: '60' })
  assert.equal(r.status, 0, '30 s old with a 60 s bound: ' + r.stdout + r.stderr)
  r = run({ IDEA_HC_CODE: '503', IDEA_HC_BODY: MAINT, IDEA_BACKUP_MARKER_MAX_AGE_S: '10' })
  assert.equal(r.status, 1, '30 s old with a 10 s bound: ' + r.stdout + r.stderr)
})

it('maintenance without the backup marker is unhealthy', () => {
  const r = run({ IDEA_HC_CODE: '503', IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 1, r.stdout + r.stderr)
})

it('down: curl failure is unhealthy', () => {
  const r = run({ IDEA_HC_FAIL: '1' })
  assert.equal(r.status, 1, r.stdout + r.stderr)
})

it('HTTP 200 still upgrading, HTTP 200 not installed, HTTP 503 without maintenance, and HTTP 500 are unhealthy', () => {
  const cases = [
    { IDEA_HC_CODE: '200', IDEA_HC_BODY: '{"installed":true,"maintenance":false,"needsDbUpgrade":true}' },
    { IDEA_HC_CODE: '200', IDEA_HC_BODY: '{"installed":false,"maintenance":false,"needsDbUpgrade":false}' },
    { IDEA_HC_CODE: '503', IDEA_HC_BODY: '{"installed":false,"maintenance":false,"needsDbUpgrade":false}' },
    { IDEA_HC_CODE: '500', IDEA_HC_BODY: READY },
  ]
  writeFileSync(marker, '')
  for (const env of cases) {
    const r = run(env)
    assert.equal(r.status, 1, JSON.stringify(env) + r.stdout + r.stderr)
  }
})
