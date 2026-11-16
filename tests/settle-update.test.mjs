/**
 * Unit tests for hooks/settle-update.sh. No Docker: fake curl + OCC.
 * Exit 0 settled, 3 not yet, other error. Read-only: no cron.php.
 * App version checks live in verify, not here.
 * Run: node --test tests/
 */
import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(root, 'hooks/settle-update.sh')
const READY = '{"installed":true,"maintenance":false,"needsDbUpgrade":false,"version":"x"}'
const MAINT = '{"installed":true,"maintenance":true,"needsDbUpgrade":false}'
const NEEDDB = '{"installed":true,"maintenance":false,"needsDbUpgrade":true}'
const NOTINST = '{"installed":false,"maintenance":false,"needsDbUpgrade":false}'
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
  spawnSync('chmod', ['755', join(bin, 'curl')])
  occ = join(dir, 'occ')
  writeFileSync(occ, `#!/bin/sh
if [ "$1" = "background-job:list" ]; then
  if [ "$IDEA_JOBS_MISSING" = 1 ]; then
    echo 'Command "background-job:list" is not defined.' >&2
    exit 1
  fi
  if [ "$IDEA_JOBS_FAIL" = 1 ]; then
    echo 'occ failed' >&2
    exit 1
  fi
  if [ "$IDEA_JOBS_PENDING" = 1 ]; then
    echo "  12  OC\\\\Migration\\\\BackgroundRepair  0  []"
    exit 0
  fi
  echo "  3  OCA\\\\Activity\\\\BackgroundJob\\\\ExpireActivities  1  []"
  exit 0
fi
exit 1
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
    IDEA_UPDATE_STATE_DIR: join(dir, 'state'),
    ...env,
  },
})

it('exit 0 when status.php is ready and no upgrade jobs are pending', () => {
  const r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /settled/)
})

it('exit 3 when status.php is unreachable or in maintenance or needs a DB upgrade', () => {
  let r = run({ IDEA_CURL_FAIL: '1' })
  assert.equal(r.status, 3, r.stdout + r.stderr)
  assert.match(r.stdout, /not yet: status.php unreachable/)
  r = run({ IDEA_HC_CODE: '503', IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 3, r.stdout + r.stderr)
  r = run({ IDEA_HC_BODY: MAINT })
  assert.equal(r.status, 3, r.stdout + r.stderr)
  assert.match(r.stdout, /not yet: status.php maintenance is not false/)
  r = run({ IDEA_HC_BODY: NEEDDB })
  assert.equal(r.status, 3, r.stdout + r.stderr)
  assert.match(r.stdout, /not yet: status.php needsDbUpgrade is not false/)
})

it('exit 1 when installed is false', () => {
  const r = run({ IDEA_HC_BODY: NOTINST })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /ERROR: status.php installed is not true/)
})

it('exit 3 when upgrade jobs are still pending', () => {
  const r = run({ IDEA_JOBS_PENDING: '1' })
  assert.equal(r.status, 3, r.stdout + r.stderr)
  assert.match(r.stdout, /not yet: upgrade jobs still pending/)
})

it('exit 0 when the job probe is unavailable, if status.php is ready', () => {
  const r = run({ IDEA_JOBS_MISSING: '1' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /upgrade-job probe unavailable/)
  assert.match(r.stdout, /settled/)
})

it('exit 3 when the job probe fails for another reason', () => {
  const r = run({ IDEA_JOBS_FAIL: '1' })
  assert.equal(r.status, 3, r.stdout + r.stderr)
  assert.match(r.stdout, /not yet: upgrade-job probe failed/)
})

it('does not invoke cron.php (settle is read-only)', () => {
  const src = spawnSync('cat', [SCRIPT], { encoding: 'utf8' }).stdout
  const body = src.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
  assert.ok(!/cron\.php/.test(body), 'settle must not invoke cron.php')
})

it('refuses leftover argv', () => {
  const r = run({}, ['apache2-foreground'])
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /ERROR: unexpected arguments: apache2-foreground/)
})
