/**
 * app-nextcloud#29: nextcloud-app Docker healthcheck. Run: node --test tests/
 */
import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs'
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

it('maintenance with the backup marker: HTTP 503 with maintenance true is alive', () => {
  writeFileSync(marker, '')
  const r = run({ IDEA_HC_CODE: '503', IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(r.stdout, '')
})

it('maintenance without the backup marker is unhealthy', () => {
  const r = run({ IDEA_HC_CODE: '503', IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 1, r.stdout + r.stderr)
})

it('down: curl failure is unhealthy', () => {
  const r = run({ IDEA_HC_FAIL: '1' })
  assert.equal(r.status, 1, r.stdout + r.stderr)
})

it('HTTP 200 still upgrading, HTTP 503 without maintenance, and HTTP 500 are unhealthy', () => {
  const cases = [
    { IDEA_HC_CODE: '200', IDEA_HC_BODY: '{"installed":true,"maintenance":false,"needsDbUpgrade":true}' },
    { IDEA_HC_CODE: '503', IDEA_HC_BODY: '{"installed":false,"maintenance":false,"needsDbUpgrade":false}' },
    { IDEA_HC_CODE: '500', IDEA_HC_BODY: READY },
  ]
  writeFileSync(marker, '')
  for (const env of cases) {
    const r = run(env)
    assert.equal(r.status, 1, JSON.stringify(env) + r.stdout + r.stderr)
  }
})
