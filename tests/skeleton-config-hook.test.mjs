/**
 * pre-installation/05-idea-skeleton-config.sh (symlinked in before-starting):
 * copy config/idea-skeleton.config.php into Nextcloud's config dir before
 * maintenance:install, so even the install-time admin gets no example files (idea#464).
 * Run: node --test tests/
 */
import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, lstatSync, realpathSync, statSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRE = join(root, 'docker-entrypoint-hooks.d/pre-installation/05-idea-skeleton-config.sh')
const BEFORE = join(root, 'docker-entrypoint-hooks.d/before-starting/05-idea-skeleton-config.sh')
const CONF = join(root, 'config/idea-skeleton.config.php')
const NAME = 'idea-skeleton.config.php'
let dir, dst
const run = (hook = PRE, extra = {}) => {
  const r = spawnSync(hook, [], { encoding: 'utf8', env: { PATH: process.env.PATH, IDEA_CONFIG_SRC: join(root, 'config'), IDEA_NC_CONFIG_DIR: dst, ...extra } })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  return r.stdout
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'idea-skelcfg-')); dst = join(dir, 'config'); mkdirSync(dst) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('config file sets both keys to empty strings and nothing else', () => {
  const s = readFileSync(CONF, 'utf8')
  assert.ok(s.startsWith('<?php\n'), 'no leading content before <?php (Nextcloud refuses it)')
  const body = s.slice(s.indexOf('$CONFIG = ['))
  assert.match(body, /'skeletondirectory' => '',/)
  assert.match(body, /'templatedirectory' => '',/)
  assert.equal((body.match(/=>/g) || []).length, 2)
  assert.ok(NAME.endsWith('.config.php'), 'Nextcloud only merges config/*.config.php')
})

it('hook is executable in pre-installation; before-starting is a symlink to it', () => {
  assert.ok(statSync(PRE).mode & 0o111)
  assert.ok(lstatSync(BEFORE).isSymbolicLink())
  assert.equal(realpathSync(BEFORE), realpathSync(PRE))
})

it('fresh config dir: installs the file, mode 0640, same bytes', () => {
  assert.match(run(), /installed idea-skeleton\.config\.php/)
  assert.equal(readFileSync(join(dst, NAME), 'utf8'), readFileSync(CONF, 'utf8'))
  assert.equal(statSync(join(dst, NAME)).mode & 0o777, 0o640)
  assert.deepEqual(readdirSync(dst), [NAME], 'no temp files left')
})

it('second run (restart): already in place, file untouched', () => {
  run()
  const m = statSync(join(dst, NAME)).mtimeMs
  assert.match(run(BEFORE), /already in place/)
  assert.equal(statSync(join(dst, NAME)).mtimeMs, m)
})

it('existing install with an outdated copy: replaced (updateApp)', () => {
  writeFileSync(join(dst, NAME), "<?php\n$CONFIG = ['skeletondirectory' => '/var/www/html/core/skeleton'];\n")
  writeFileSync(join(dst, 'config.php'), "<?php\n$CONFIG = ['version' => '31.0.1.2'];\n")
  assert.match(run(BEFORE), /installed/)
  assert.equal(readFileSync(join(dst, NAME), 'utf8'), readFileSync(CONF, 'utf8'))
  assert.match(readFileSync(join(dst, 'config.php'), 'utf8'), /31\.0\.1\.2/, 'config.php is never touched')
})

it('source missing (no ./config bind): warns, exits 0, writes nothing', () => {
  assert.match(run(PRE, { IDEA_CONFIG_SRC: join(dir, 'nope') }), /WARNING .* missing — skip/)
  assert.deepEqual(readdirSync(dst), [])
})

it('config dir missing: warns, exits 0', () => {
  assert.match(run(PRE, { IDEA_NC_CONFIG_DIR: join(dir, 'absent') }), /WARNING .* missing — skip/)
  assert.ok(!existsSync(join(dir, 'absent')))
})

it('unwritable config dir: warns, exits 0 (fail open)', { skip: process.getuid?.() === 0 }, () => {
  spawnSync('chmod', ['0555', dst])
  try { assert.match(run(), /WARNING could not install/) } finally { spawnSync('chmod', ['0755', dst]) }
  assert.ok(!existsSync(join(dst, NAME)))
})
