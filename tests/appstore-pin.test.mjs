/**
 * App store pin (Steve's decision 2026-11-16, Axle review §#456 L option (a)).
 *  - prepare (hooks/prep-custom-apps-for-upgrade.sh -> hooks/appstore-pin.php) sets
 *    appstoreenabled=false in config.php and records the previous value (or "unset")
 *    in custom_apps/.idea-update-state/appstoreenabled.state, state first.
 *  - work (hooks/work-update.sh -> update-lib.sh idea_appstore_restore) restores it
 *    with occ first, before cron.php, then removes the state file (Steve's S4 decision).
 *  - settle (hooks/settle-update.sh) is a read-only probe and makes no writes (gap 8).
 * The pin tests need php (skipped without it); the restore tests use a fake occ.
 * No Docker. Run: node --test tests/*.test.mjs
 */
import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PREP = join(root, 'hooks/prep-custom-apps-for-upgrade.sh')
const PIN = join(root, 'hooks/appstore-pin.php')
const SETTLE = join(root, 'hooks/settle-update.sh')
const WORK = join(root, 'hooks/work-update.sh')
const BUNDLED = join(root, 'bundled-apps')
const HAS_PHP = spawnSync('php', ['-v'], { encoding: 'utf8' }).status === 0
const NO_PHP = HAS_PHP ? false : 'php not installed'
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const READY = '{"installed":true,"maintenance":false,"needsDbUpgrade":false,"version":"x"}'
const MAINT = '{"installed":true,"maintenance":true,"needsDbUpgrade":false}'

let dir, html, cfg, dst, stateDir, state, bin, occ, calls, cron, cronLog

const configWith = (extra = '') =>
  `<?php\n$CONFIG = array (\n  'instanceid' => 'oc123',\n  'version' => '31.0.14.1',\n  'installed' => true,\n${extra});\n`
// Parse config.php with php itself (what Nextcloud does).
const readConfig = (path = cfg) => {
  const r = spawnSync('php', ['-r', '$CONFIG=null; include $argv[1]; echo json_encode($CONFIG);', path], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idea-pin-'))
  html = join(dir, 'data', 'nextcloud')
  dst = join(html, 'custom_apps')
  mkdirSync(join(html, 'config'), { recursive: true })
  mkdirSync(dst, { recursive: true })
  cfg = join(html, 'config', 'config.php')
  writeFileSync(cfg, configWith())
  stateDir = join(dst, '.idea-update-state')
  state = join(stateDir, 'appstoreenabled.state')
  // prepare inputs: the real bundled tarballs, apps already at target (staging is a no-op).
  const src = join(dir, 'bundled-apps')
  cpSync(BUNDLED, src, { recursive: true })
  // fake curl + occ for settle
  bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w|-m) shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$out" ] && printf '%s' "$IDEA_HC_BODY" > "$out"
printf '200'
`)
  chmodSync(join(bin, 'curl'), 0o755)
  calls = join(dir, 'occ-calls')
  occ = join(dir, 'occ')
  writeFileSync(occ, `#!/bin/sh
if [ "$1" = "background-job:list" ]; then exit 0; fi
# work's schema repairs (engine#456) are covered in work-update.test.mjs; not logged here.
case "$1" in db:add-missing-*|maintenance:repair) exit 0 ;; esac
printf '%s\\n' "$*" >> "${calls}"
case "$1" in
  config:system:*) [ "$IDEA_OCC_CONFIG_FAIL" = 1 ] && { echo "occ failed" >&2; exit 1; }; exit 0 ;;
esac
exit 1
`)
  chmodSync(occ, 0o755)
  cronLog = join(dir, 'cron-log')
  cron = join(dir, 'cron')
  writeFileSync(cron, `#!/bin/sh
echo run >> "${cronLog}"
[ "$IDEA_CRON_FAIL" = 1 ] && exit 1
exit 0
`)
  chmodSync(cron, 0o755)
})
afterEach(() => {
  try { chmodSync(cfg, 0o640) } catch {}
  rmSync(dir, { recursive: true, force: true })
})

const prep = (extra = {}) => spawnSync(PREP, [], {
  encoding: 'utf8',
  env: {
    PATH: process.env.PATH,
    IDEA_BUNDLED_APPS: join(dir, 'bundled-apps'),
    IDEA_CUSTOM_APPS: dst,
    IDEA_NC_CONFIG: cfg,
    ...extra,
  },
})
// Direct pin calls: prepare creates the state dir before calling the pin.
const pin = (extra = {}) => {
  mkdirSync(stateDir, { recursive: true })
  return spawnSync('php', [PIN, cfg, state], { encoding: 'utf8', env: { PATH: process.env.PATH, ...extra } })
}
const settle = (extra = {}) => spawnSync(SETTLE, [], {
  encoding: 'utf8',
  env: {
    PATH: `${bin}:${process.env.PATH}`,
    OCC: occ,
    IDEA_HC_BODY: READY,
    IDEA_UPDATE_STATE_DIR: stateDir,
    ...extra,
  },
})
const work = (extra = {}) => spawnSync(WORK, [], {
  encoding: 'utf8',
  env: {
    PATH: `${bin}:${process.env.PATH}`,
    OCC: occ,
    IDEA_CRON: cron,
    IDEA_UPDATE_STATE_DIR: stateDir,
    ...extra,
  },
})
const cronRuns = () => existsSync(cronLog) ? readFileSync(cronLog, 'utf8').trim().split('\n').filter(Boolean).length : 0
const occCalls = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []
const writeState = (prev) => { mkdirSync(stateDir, { recursive: true }); writeFileSync(state, `# test\nprevious=${prev}\n`) }
const stateLine = () => readFileSync(state, 'utf8').split('\n').find(l => l.startsWith('previous='))

// ---- prepare: pin ----

it('prepare pins appstoreenabled=false and records previous=unset on the data volume', { skip: NO_PHP }, () => {
  const r = prep()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /recorded previous=unset/)
  assert.match(r.stdout, /pinned appstoreenabled=false/)
  const c = readConfig()
  assert.equal(c.appstoreenabled, false)
  assert.equal(c.version, '31.0.14.1')
  assert.equal(c.instanceid, 'oc123')
  assert.equal(stateLine(), 'previous=unset')
  assert.equal(statSync(cfg).mode & 0o777, 0o640)
  // Same format as Nextcloud's Config::writeData().
  assert.match(readFileSync(cfg, 'utf8'), /^<\?php\n\$CONFIG = array \(\n/)
})

it('records previous=bool:true when the app store was explicitly on', { skip: NO_PHP }, () => {
  writeFileSync(cfg, configWith("  'appstoreenabled' => true,\n"))
  const r = pin()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(stateLine(), 'previous=bool:true')
  assert.equal(readConfig().appstoreenabled, false)
})

it('already false: records bool:false and does not rewrite config.php', { skip: NO_PHP }, () => {
  writeFileSync(cfg, configWith("  'appstoreenabled' => false,\n"))
  const before = readFileSync(cfg, 'utf8')
  const r = pin()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /already false in config.php \(no write\)/)
  assert.equal(readFileSync(cfg, 'utf8'), before)
  assert.equal(stateLine(), 'previous=bool:false')
})

it('records strings and integers losslessly (base64 for strings)', { skip: NO_PHP }, () => {
  writeFileSync(cfg, configWith("  'appstoreenabled' => 'yes please',\n"))
  assert.equal(pin().status, 0)
  assert.equal(stateLine(), `previous=string:${Buffer.from('yes please').toString('base64')}`)
  rmSync(state)
  writeFileSync(cfg, configWith("  'appstoreenabled' => 1,\n"))
  assert.equal(pin().status, 0)
  assert.equal(stateLine(), 'previous=int:1')
})

it('retry is idempotent: a second prepare keeps the first recorded value (first record wins)', { skip: NO_PHP }, () => {
  assert.equal(prep().status, 0)
  const r = prep()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /already records previous=unset \(kept, first record wins\)/)
  assert.equal(stateLine(), 'previous=unset')
  assert.equal(readConfig().appstoreenabled, false)
})

it('a leftover state file from an earlier hop is kept, never overwritten with the pinned false', { skip: NO_PHP }, () => {
  writeState('bool:true')
  writeFileSync(cfg, configWith("  'appstoreenabled' => false,\n"))
  const r = pin()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(stateLine(), 'previous=bool:true')
})

it('refuses (no change) when another config/*.config.php sets appstoreenabled', { skip: NO_PHP }, () => {
  writeFileSync(join(html, 'config', 'zz.config.php'), "<?php\n$CONFIG = array ('appstoreenabled' => true);\n")
  const before = readFileSync(cfg, 'utf8')
  const r = prep()
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /^ERROR: app store pin failed: zz\.config\.php sets appstoreenabled.* \[idea-prep-custom-apps\]$/m)
  assert.equal(readFileSync(cfg, 'utf8'), before)
  assert.ok(!existsSync(state))
})

it('ignores other config/*.config.php files that do not set the key (e.g. idea-skeleton.config.php)', { skip: NO_PHP }, () => {
  writeFileSync(join(html, 'config', 'idea-skeleton.config.php'), "<?php\n$CONFIG = array ('skeletondirectory' => '');\n")
  assert.equal(pin().status, 0)
  assert.equal(readConfig().appstoreenabled, false)
})

it('refuses when NC_appstoreenabled is set in the environment', { skip: NO_PHP }, () => {
  const r = pin({ NC_appstoreenabled: 'true' })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /NC_appstoreenabled is set in the environment/)
  assert.ok(!existsSync(state))
})

it('refuses a config.php without version, a missing config.php, and a non-scalar value', { skip: NO_PHP }, () => {
  writeFileSync(cfg, "<?php\n$CONFIG = array ('installed' => true);\n")
  let r = pin()
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /has no 'version'; refusing to rewrite it/)
  writeFileSync(cfg, configWith("  'appstoreenabled' => array (1),\n"))
  r = pin()
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /unsupported type/)
  rmSync(cfg)
  r = pin()
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /config.php missing/)
  assert.ok(!existsSync(state))
})

it('writes the state file before config.php: a failed config write leaves config untouched and the true previous value recorded', { skip: NO_PHP || (IS_ROOT && 'root ignores file modes') }, () => {
  writeFileSync(cfg, configWith("  'appstoreenabled' => true,\n"))
  chmodSync(cfg, 0o444)
  const r = pin()
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.equal(stateLine(), 'previous=bool:true')
  assert.equal(readConfig().appstoreenabled, true)
})

it('prepare does not pin when staging fails (checksum mismatch fails closed first)', { skip: NO_PHP }, () => {
  writeFileSync(join(dir, 'bundled-apps', 'SHA256SUMS'), '')
  const r = prep()
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.doesNotMatch(readFileSync(cfg, 'utf8'), /appstoreenabled/)
  assert.ok(!existsSync(state))
})

// ---- Axle's should-fixes (S1, S2, S3, S5, NEXTCLOUD_CONFIG_DIR) ----

it('S3: a state file next to a non-false appstoreenabled is stale: logged, re-recorded with the current value, then pinned', { skip: NO_PHP }, () => {
  for (const [line, want] of [["  'appstoreenabled' => true,\n", 'previous=bool:true'], ['', 'previous=unset']]) {
    writeState('bool:false')
    writeFileSync(cfg, configWith(line))
    const r = pin()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /is stale .*recording the current value again/)
    assert.equal(stateLine(), want)
    assert.equal(readConfig().appstoreenabled, false)
  }
})

it('S3: with the pin in effect (false) the existing state file is still kept', { skip: NO_PHP }, () => {
  writeState('unset')
  writeFileSync(cfg, configWith("  'appstoreenabled' => false,\n"))
  const r = pin()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.doesNotMatch(r.stdout, /stale/)
  assert.equal(stateLine(), 'previous=unset')
})

it('S1: refuses to truncate config.php without room for content + 10 KB (nothing written to config.php)', { skip: NO_PHP }, () => {
  const before = readFileSync(cfg, 'utf8')
  const r = pin({ IDEA_PIN_TEST_DISK_FREE: '10000' })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /does not have enough free space for config\.php/)
  assert.equal(readFileSync(cfg, 'utf8'), before)
  // Plenty of space: writes.
  assert.equal(pin({ IDEA_PIN_TEST_DISK_FREE: '100000000' }).status, 0)
  assert.equal(readConfig().appstoreenabled, false)
})

it('S2: refuses when config_is_read_only is set in config.php or another *.config.php', { skip: NO_PHP }, () => {
  writeFileSync(cfg, configWith("  'config_is_read_only' => true,\n"))
  let r = prep()
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /app store pin failed: config_is_read_only is set in config\.php/)
  assert.doesNotMatch(readFileSync(cfg, 'utf8'), /appstoreenabled/)
  assert.ok(!existsSync(state))
  writeFileSync(cfg, configWith())
  writeFileSync(join(html, 'config', 'ro.config.php'), "<?php\n$CONFIG = array ('config_is_read_only' => true);\n")
  r = pin()
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /ro\.config\.php sets config_is_read_only/)
  assert.ok(!existsSync(state))
})

it('S2: config_is_read_only false is fine', { skip: NO_PHP }, () => {
  writeFileSync(cfg, configWith("  'config_is_read_only' => false,\n"))
  assert.equal(pin().status, 0)
})

it('S5: refuses a config.php that is not plain literals (code would be written back frozen)', { skip: NO_PHP }, () => {
  for (const code of [
    "  'dbpassword' => getenv('X') ?: 'fallback',\n",
    "  'datadirectory' => __DIR__ . '/data',\n",
    "  'x' => PHP_VERSION,\n",
  ]) {
    writeFileSync(cfg, configWith(code))
    const before = readFileSync(cfg, 'utf8')
    const r = pin()
    assert.equal(r.status, 1, code + r.stdout + r.stderr)
    assert.match(r.stdout, /config\.php is not plain literals/)
    assert.equal(readFileSync(cfg, 'utf8'), before)
    assert.ok(!existsSync(state))
  }
})

it('S5: accepts what Nextcloud writes (nested arrays, ints, floats, negatives, null, comments, [] and $CONFIG[...] lines)', { skip: NO_PHP }, () => {
  writeFileSync(cfg, "<?php\n// comment\n$CONFIG = array (\n  'version' => '31.0.14.1',\n  'trusted_domains' => \n  array (\n    0 => 'localhost',\n    1 => 'idea04',\n  ),\n  'loglevel' => 2,\n  'ratio' => 1.5,\n  'neg' => -1,\n  'nothing' => NULL,\n  'list' => ['a', 'b'],\n);\n$CONFIG['installed'] = true;\n")
  const r = pin()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const c = readConfig()
  assert.equal(c.appstoreenabled, false)
  assert.deepEqual(c.trusted_domains, ['localhost', 'idea04'])
  assert.equal(c.neg, -1)
  assert.equal(c.installed, true)
})

it('refuses a NEXTCLOUD_CONFIG_DIR that is not the directory of config.php; accepts the same one', { skip: NO_PHP }, () => {
  let r = pin({ NEXTCLOUD_CONFIG_DIR: join(dir, 'elsewhere') })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /NEXTCLOUD_CONFIG_DIR=.* is not the directory of/)
  assert.ok(!existsSync(state))
  r = pin({ NEXTCLOUD_CONFIG_DIR: join(html, 'config') + '/' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

// ---- work: restore (Steve's S4 decision); settle: read-only ----

it('work restores previous=unset with occ config:system:delete, removes the state file, then runs cron.php', () => {
  writeState('unset')
  const r = work()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(occCalls(), ['config:system:delete appstoreenabled'])
  assert.ok(!existsSync(state))
  assert.match(r.stdout, /restored appstoreenabled \(previous=unset\)/)
  assert.ok(r.stdout.indexOf('restored appstoreenabled') < r.stdout.indexOf('cron.php run 1'), 'restore comes before cron.php')
  assert.equal(cronRuns(), 1)
  assert.match(r.stdout, /work done/)
})

it('work restores booleans, integers and strings with the right occ --type', () => {
  for (const [prev, want] of [
    ['bool:true', 'config:system:set appstoreenabled --value=true --type=boolean'],
    ['bool:false', 'config:system:set appstoreenabled --value=false --type=boolean'],
    ['int:1', 'config:system:set appstoreenabled --value=1 --type=integer'],
    [`string:${Buffer.from('yes please').toString('base64')}`, 'config:system:set appstoreenabled --value=yes please --type=string'],
  ]) {
    rmSync(calls, { force: true })
    writeState(prev)
    const r = work()
    assert.equal(r.status, 0, prev + ': ' + r.stdout + r.stderr)
    assert.deepEqual(occCalls(), [want], prev)
    assert.ok(!existsSync(state), prev)
  }
})

it('work with no state file leaves appstoreenabled alone (nothing was pinned)', () => {
  const r = work()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(occCalls(), [])
  assert.match(r.stdout, /no state file, appstoreenabled left as is/)
})

it('a cron.php failure in work cannot leave the pin on (restore already ran)', () => {
  writeState('bool:true')
  const r = work({ IDEA_CRON_FAIL: '1' })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /ERROR: cron.php failed/)
  assert.deepEqual(occCalls(), ['config:system:set appstoreenabled --value=true --type=boolean'])
  assert.ok(!existsSync(state))
})

it('a failed restore fails work before cron.php (migrationsPending, no rollback), keeps the state file, and a re-run of work retries', () => {
  writeState('bool:true')
  let r = work({ IDEA_OCC_CONFIG_FAIL: '1' })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /ERROR: occ config:system:set appstoreenabled true failed/)
  assert.ok(existsSync(state))
  assert.equal(cronRuns(), 0)
  r = work()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(!existsSync(state))
})

it('a corrupt state file is an ERROR in work and is not removed', () => {
  writeState('maybe')
  let r = work()
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /no valid previous= line/)
  assert.ok(existsSync(state))
  writeState('int:12x')
  r = work()
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /bad integer/)
})

it('settle makes no writes: with a state file present it neither calls occ config nor removes the file', () => {
  writeState('unset')
  for (const body of [READY, MAINT]) {
    const r = settle({ IDEA_HC_BODY: body })
    assert.ok(r.status === 0 || r.status === 3, r.stdout + r.stderr)
    assert.deepEqual(occCalls(), [])
    assert.ok(existsSync(state))
    assert.equal(readFileSync(state, 'utf8'), '# test\nprevious=unset\n')
  }
})

it('round trip: prepare pins, work restores the recorded value, settle then changes nothing', { skip: NO_PHP }, () => {
  writeFileSync(cfg, configWith("  'appstoreenabled' => true,\n"))
  assert.equal(prep().status, 0)
  assert.equal(readConfig().appstoreenabled, false)
  let r = work()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(occCalls(), ['config:system:set appstoreenabled --value=true --type=boolean'])
  assert.ok(!existsSync(state))
  r = settle()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(occCalls(), ['config:system:set appstoreenabled --value=true --type=boolean'])
})

// ---- wiring / docs (string checks, repo pattern) ----

it('state file lives under custom_apps on the data volume (kept by the image upgrade rsync), not /tmp', () => {
  const prepSrc = readFileSync(PREP, 'utf8')
  const libSrc = readFileSync(join(root, 'hooks/update-lib.sh'), 'utf8')
  assert.match(prepSrc, /STATE_DIR="\$\{IDEA_UPDATE_STATE_DIR:-\$DST\/\.idea-update-state\}"/)
  assert.match(prepSrc, /DST="\$\{IDEA_CUSTOM_APPS:-\/var\/www\/html\/custom_apps\}"/)
  assert.match(libSrc, /IDEA_UPDATE_STATE_DIR:-\/var\/www\/html\/custom_apps\/\.idea-update-state/)
  assert.doesNotMatch(prepSrc + libSrc, /appstoreenabled\.state.*\/tmp|\/tmp.*appstoreenabled/)
})

it('work calls idea_appstore_restore before its cron.php loop; settle has no restore and no occ config write', () => {
  const strip = (f) => readFileSync(f, 'utf8').split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
  const w = strip(WORK)
  assert.ok(w.indexOf('idea_appstore_restore') > 0 && w.indexOf('idea_appstore_restore') < w.indexOf('while [ "$run" -le "$max" ]'))
  const st = strip(SETTLE)
  assert.doesNotMatch(st, /idea_appstore_restore|config:system|appstoreenabled|idea-update-state|STATE/)
  // No rm of its own: its one temp file is made with idea_mktemp and removed by the
  // update-lib.sh EXIT / TERM traps (engine#456 TERM safety).
  assert.equal(st.match(/rm -f/g), null)
  assert.match(st, /idea_mktemp body /)
  assert.match(st, /idea_install_traps/)
})

it('compose mounts the whole hooks dir (appstore-pin.php is visible at /idea/hooks) and docs describe the pin and the >= rule', () => {
  const compose = readFileSync(join(root, 'compose.yaml'), 'utf8')
  assert.match(compose, /- \.\/hooks:\/idea\/hooks:ro/)
  assert.match(compose, /appstoreenabled/)
  const rel = readFileSync(join(root, 'docs/releases.md'), 'utf8')
  assert.match(rel, /App store pin/)
  assert.match(rel, /appstoreenabled/)
  assert.match(rel, /pinned version or newer/)
})
