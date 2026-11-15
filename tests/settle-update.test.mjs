/**
 * Unit tests for hooks/settle-update.sh. No Docker: fake curl + OCC.
 * Exit 0 settled, 3 not yet, other error.
 * Run: node --test tests/
 */
import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(root, 'hooks/settle-update.sh')
const READY = '{"installed":true,"maintenance":false,"needsDbUpgrade":false,"version":"32.0.15.1"}'
const MAINT = '{"installed":true,"maintenance":true,"needsDbUpgrade":false}'
const NEEDDB = '{"installed":true,"maintenance":false,"needsDbUpgrade":true}'
const NOTINST = '{"installed":false,"maintenance":false,"needsDbUpgrade":false}'
const APPLIST = `Enabled:
  - activity: 4.0.0
  - idea_usage: 1.0.0
  - richdocuments: 9.2.3
Disabled:
  - firstrunwizard: 9.0.0
`
let dir, bin, occ

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idea-settle-'))
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
  chmodSync(join(bin, 'curl'), 0o755)
  occ = join(dir, 'occ')
  writeFileSync(occ, `#!/bin/sh
if [ "\$IDEA_OCC_FAIL" = 1 ]; then exit 1; fi
printf '%s' "\$IDEA_OCC_LIST"
exit 0
`)
  chmodSync(occ, 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const run = (env = {}) => spawnSync(SCRIPT, [], {
  encoding: 'utf8',
  env: {
    PATH: `${bin}:${process.env.PATH}`,
    OCC: occ,
    IDEA_NC_HEALTH_URL: 'http://127.0.0.1/status.php',
    IDEA_HC_BODY: READY,
    IDEA_OCC_LIST: APPLIST,
    ...env,
  },
})

it('exit 0 when status.php is ready and both apps are enabled at the target versions', () => {
  const r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /settled/)
})

it('exit 3 when status.php is unreachable or in maintenance or needs a DB upgrade', () => {
  let r = run({ IDEA_CURL_FAIL: '1' })
  assert.equal(r.status, 3, r.stdout + r.stderr)
  r = run({ IDEA_HC_CODE: '503', IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 3, r.stdout + r.stderr)
  r = run({ IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 3, r.stdout + r.stderr)
  r = run({ IDEA_HC_BODY: NEEDDB })
  assert.equal(r.status, 3, r.stdout + r.stderr)
})

it('exit 1 when installed is false or an app is missing, disabled, or the wrong version', () => {
  let r = run({ IDEA_HC_BODY: NOTINST })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /installed is not true/)
  r = run({ IDEA_OCC_LIST: 'Enabled:\n  - idea_usage: 1.0.0\nDisabled:\n  - richdocuments: 9.2.3\n' })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /richdocuments 9\.2\.3 is not enabled/)
  r = run({ IDEA_OCC_LIST: 'Enabled:\n  - richdocuments: 8.8.3\n  - idea_usage: 1.0.0\nDisabled:\n' })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /richdocuments 9\.2\.3 is not enabled/)
  r = run({ IDEA_OCC_LIST: 'Enabled:\n  - richdocuments: 9.2.3\nDisabled:\n  - idea_usage: 1.0.0\n' })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /idea_usage 1\.0\.0 is not enabled/)
})

it('exit 3 when occ app:list fails (transient)', () => {
  const r = run({ IDEA_OCC_FAIL: '1' })
  assert.equal(r.status, 3, r.stdout + r.stderr)
  assert.match(r.stdout, /occ app:list failed/)
})
