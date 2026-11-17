/**
 * Unit tests for hooks/work-update.sh. No Docker: fake OCC + cron.php.
 * Exit 0 done, 3 still pending after the cron series, 1 on cron or occ repair failure.
 * Run: node --test tests/
 */
import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(root, 'hooks/work-update.sh')
let dir, occ, cron, occState, cronState, occLog

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idea-work-'))
  occState = join(dir, 'occ-state')
  cronState = join(dir, 'cron-state')
  occLog = join(dir, 'occ-log')
  writeFileSync(occLog, '')
  writeFileSync(occState, '0')
  writeFileSync(cronState, '0')
  occ = join(dir, 'occ')
  writeFileSync(occ, `#!/bin/sh
# IDEA_OCC_JOBS_SEQ is a comma-separated list of: pending | clear | missing | fail
# Advanced on each background-job:list call. Every call is logged to
# IDEA_OCC_LOG; any other command succeeds unless it is IDEA_OCC_FAIL_CMD.
echo "$*" >> "$IDEA_OCC_LOG"
if [ "$1" != background-job:list ]; then
  [ "$1" = "\${IDEA_OCC_FAIL_CMD:-}" ] && { echo "$1 failed" >&2; exit 1; }
  echo "Done."; exit 0
fi
state="$IDEA_OCC_STATE"
n=$(cat "$state")
seq=\${IDEA_OCC_JOBS_SEQ:-clear}
item=$(printf '%s' "$seq" | awk -F, -v n="$n" '{print $(n+1)}')
[ -n "$item" ] || item=$(printf '%s' "$seq" | awk -F, '{print $NF}')
echo $((n + 1)) > "$state"
case "$item" in
  pending) echo "  12  OC\\\\Migration\\\\BackgroundRepair  0  []"; exit 0 ;;
  clear) echo "  3  OCA\\\\Activity\\\\BackgroundJob\\\\ExpireActivities  1  []"; exit 0 ;;
  missing) echo 'Command "background-job:list" is not defined.' >&2; exit 1 ;;
  fail) echo 'occ failed' >&2; exit 1 ;;
  *) echo "unknown item $item" >&2; exit 1 ;;
esac
`)
  spawnSync('chmod', ['755', occ])
  cron = join(dir, 'cron')
  writeFileSync(cron, `#!/bin/sh
state="$IDEA_CRON_STATE"
n=$(cat "$state")
echo $((n + 1)) > "$state"
[ "$IDEA_CRON_FAIL_ON" = "$((n + 1))" ] && exit 1
exit 0
`)
  spawnSync('chmod', ['755', cron])
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const run = (env = {}, args = []) => spawnSync(SCRIPT, args, {
  encoding: 'utf8',
  env: {
    PATH: process.env.PATH,
    OCC: occ,
    IDEA_CRON: cron,
    IDEA_OCC_STATE: occState,
    IDEA_CRON_STATE: cronState,
    IDEA_OCC_LOG: occLog,
    IDEA_OCC_JOBS_SEQ: 'clear',
    ...env,
  },
})

it('runs cron.php once and exits 0 when no upgrade jobs remain', () => {
  const r = run({ IDEA_OCC_JOBS_SEQ: 'clear' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /cron\.php run 1 of 3/)
  assert.match(r.stdout, /no pending upgrade jobs/)
  assert.match(r.stdout, /work done/)
  assert.doesNotMatch(r.stdout, /cron\.php run 2/)
  assert.equal(readFileSync(cronState, 'utf8').trim(), '1')
})

it('runs cron.php again while upgrade jobs remain, then exits 0 once clear', () => {
  const r = run({ IDEA_OCC_JOBS_SEQ: 'pending,pending,clear' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /cron\.php run 3 of 3/)
  assert.match(r.stdout, /work done/)
  assert.equal(readFileSync(cronState, 'utf8').trim(), '3')
})

it('exit 3 when upgrade jobs remain after the last cron.php run', () => {
  const r = run({ IDEA_OCC_JOBS_SEQ: 'pending', IDEA_WORK_CRON_RUNS: '2' })
  assert.equal(r.status, 3, r.stdout + r.stderr)
  assert.match(r.stdout, /not yet: upgrade jobs still pending after 2 cron\.php run\(s\)/)
  assert.equal(readFileSync(cronState, 'utf8').trim(), '2')
})

it('exit 1 when cron.php fails', () => {
  const r = run({ IDEA_CRON_FAIL_ON: '1' })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /ERROR: cron\.php failed on run 1 of 3/)
})

it('treats a missing background-job:list command as done after the cron series', () => {
  const r = run({ IDEA_OCC_JOBS_SEQ: 'missing', IDEA_WORK_CRON_RUNS: '2' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /upgrade-job probe unavailable/)
  assert.match(r.stdout, /treating work as done/)
  assert.equal(readFileSync(cronState, 'utf8').trim(), '2')
})

it('refuses leftover argv and does not run cron.php', () => {
  const r = run({}, ['apache2-foreground'])
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /ERROR: unexpected arguments: apache2-foreground/)
  assert.equal(readFileSync(cronState, 'utf8').trim(), '0')
})

const occCalls = () => readFileSync(occLog, 'utf8').split('\n').filter(Boolean)
const REPAIR = [
  'db:add-missing-indices --no-interaction',
  'db:add-missing-columns --no-interaction',
  'db:add-missing-primary-keys --no-interaction',
  'maintenance:repair --include-expensive --no-interaction',
]

it('runs the occ schema repairs once, in order, before the first cron.php run (engine#456)', () => {
  const r = run({ IDEA_OCC_JOBS_SEQ: 'clear' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const calls = occCalls()
  assert.deepEqual(calls.slice(0, 4), REPAIR)
  assert.deepEqual(calls.slice(4), ['background-job:list'])
  assert.ok(r.stdout.indexOf('maintenance:repair --include-expensive') < r.stdout.indexOf('cron.php run 1'))
})

it('a second work run repeats the repairs (idempotent; Resume after migrationsPending re-runs work)', () => {
  assert.equal(run().status, 0)
  assert.equal(run().status, 0)
  assert.equal(occCalls().filter(c => c.startsWith('db:add-missing-indices')).length, 2)
})

for (const cmd of ['db:add-missing-indices', 'db:add-missing-primary-keys', 'maintenance:repair']) {
  it(`exit 1 with an ERROR line and no cron.php when occ ${cmd} fails`, () => {
    const r = run({ IDEA_OCC_FAIL_CMD: cmd })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout, new RegExp(`ERROR: occ ${cmd}( --include-expensive)? failed`))
    assert.equal(readFileSync(cronState, 'utf8').trim(), '0')
    assert.ok(!occCalls().includes('background-job:list'))
  })
}

it('IDEA_WORK_REPAIR_EXPENSIVE=0 runs maintenance:repair without --include-expensive', () => {
  const r = run({ IDEA_WORK_REPAIR_EXPENSIVE: '0' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(occCalls().includes('maintenance:repair --no-interaction'))
  assert.ok(!occCalls().some(c => c.includes('--include-expensive')))
})

it('IDEA_WORK_SCHEMA_REPAIR=0 skips the repairs; a bad value is an ERROR', () => {
  const r = run({ IDEA_WORK_SCHEMA_REPAIR: '0' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /schema repair skipped/)
  assert.deepEqual(occCalls(), ['background-job:list'])
  const bad = run({ IDEA_WORK_SCHEMA_REPAIR: 'yes' })
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /ERROR: IDEA_WORK_SCHEMA_REPAIR must be 0 or 1/)
})
