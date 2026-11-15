/**
 * Unit tests for hooks/prep-custom-apps-for-upgrade.sh. No Docker: a temp dir
 * stands in for ./data/nextcloud/custom_apps and ./bundled-apps.
 * Run: node --test tests/
 */
import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, readdirSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(root, 'hooks/prep-custom-apps-for-upgrade.sh')
const BUNDLED = join(root, 'bundled-apps')
let dir, src, dst

const sha256 = async (file) => {
  const h = createHash('sha256')
  await pipeline(createReadStream(file), h)
  return h.digest('hex')
}

const writeInfo = (appDir, version, max = '31') => {
  mkdirSync(join(appDir, 'appinfo'), { recursive: true })
  writeFileSync(join(appDir, 'appinfo/info.xml'),
    `<?xml version="1.0"?>\n<info>\n  <version>${version}</version>\n  <dependencies><nextcloud min-version="31" max-version="${max}"/></dependencies>\n</info>\n`)
}

const seedOldApps = () => {
  writeInfo(join(dst, 'richdocuments'), '8.8.3', '31')
  writeFileSync(join(dst, 'richdocuments', 'OLD'), 'old-richdocuments')
  writeInfo(join(dst, 'idea_usage'), '1.0.0', '31')
  writeFileSync(join(dst, 'idea_usage', 'OLD'), 'old-usage')
}

const envFor = (extra = {}) => ({
  PATH: process.env.PATH,
  IDEA_BUNDLED_APPS: src,
  IDEA_CUSTOM_APPS: dst,
  ...extra,
})

const run = (extra = {}) => spawnSync(SCRIPT, ['apache2-foreground'], { encoding: 'utf8', env: envFor(extra) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'idea-prep-'))
  src = join(dir, 'bundled-apps')
  dst = join(dir, 'data', 'nextcloud', 'custom_apps')
  mkdirSync(src, { recursive: true })
  mkdirSync(dst, { recursive: true })
  for (const f of ['idea_usage-v1.0.0.tar.gz', 'richdocuments-v9.2.3.tar.gz', 'SHA256SUMS']) {
    cpSync(join(BUNDLED, f), join(src, f))
  }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('replaces 8.8.3 / 31-only idea_usage, backs them up, and extracts 9.2.3 and max-version 32', () => {
  seedOldApps()
  const r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /backed up richdocuments 8\.8\.3/)
  assert.match(r.stdout, /installed richdocuments 9\.2\.3/)
  assert.match(r.stdout, /backed up idea_usage 1\.0\.0/)
  assert.match(r.stdout, /installed idea_usage 1\.0\.0 \(max-version 32\)/)
  const rd = readFileSync(join(dst, 'richdocuments/appinfo/info.xml'), 'utf8')
  assert.match(rd, /<version>9\.2\.3<\/version>/)
  assert.match(rd, /max-version="32"/)
  assert.ok(!existsSync(join(dst, 'richdocuments/OLD')))
  const usage = readFileSync(join(dst, 'idea_usage/appinfo/info.xml'), 'utf8')
  assert.match(usage, /<version>1\.0\.0<\/version>/)
  assert.match(usage, /max-version="32"/)
  assert.ok(!existsSync(join(dst, 'idea_usage/OLD')))
  const backup = join(dst, '.idea-upgrade-backup')
  const names = readdirSync(backup).sort()
  const rdBak = names.find(n => n.startsWith('richdocuments-8.8.3-'))
  const usBak = names.find(n => n.startsWith('idea_usage-1.0.0-'))
  assert.ok(rdBak, names.join(','))
  assert.ok(usBak, names.join(','))
  assert.equal(readFileSync(join(backup, rdBak, 'OLD'), 'utf8'), 'old-richdocuments')
  assert.equal(readFileSync(join(backup, usBak, 'OLD'), 'utf8'), 'old-usage')
})

it('second run is a no-op: no new backup, trees stay at the target versions', () => {
  seedOldApps()
  assert.equal(run().status, 0)
  const backup = join(dst, '.idea-upgrade-backup')
  const first = readdirSync(backup).sort()
  const rdMtime = statSync(join(dst, 'richdocuments/appinfo/info.xml')).mtimeMs
  const r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /richdocuments already at 9\.2\.3/)
  assert.match(r.stdout, /idea_usage already at 1\.0\.0 \(max-version 32\)/)
  assert.doesNotMatch(r.stdout, /backed up/)
  assert.deepEqual(readdirSync(backup).sort(), first)
  assert.equal(statSync(join(dst, 'richdocuments/appinfo/info.xml')).mtimeMs, rdMtime)
  assert.match(readFileSync(join(dst, 'richdocuments/appinfo/info.xml'), 'utf8'), /<version>9\.2\.3<\/version>/)
})

it('checksum mismatch exits non-zero and leaves existing apps untouched', async () => {
  seedOldApps()
  writeFileSync(join(src, 'SHA256SUMS'),
    `${'0'.repeat(64)}  idea_usage-v1.0.0.tar.gz\n${'0'.repeat(64)}  richdocuments-v9.2.3.tar.gz\n`)
  const r = run()
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /ERROR: idea_usage-v1\.0\.0\.tar\.gz checksum mismatch|ERROR: richdocuments-v9\.2\.3\.tar\.gz checksum mismatch/)
  assert.match(readFileSync(join(dst, 'richdocuments/appinfo/info.xml'), 'utf8'), /<version>8\.8\.3<\/version>/)
  assert.match(readFileSync(join(dst, 'idea_usage/appinfo/info.xml'), 'utf8'), /max-version="31"/)
  assert.ok(existsSync(join(dst, 'richdocuments/OLD')))
  assert.ok(!existsSync(join(dst, '.idea-upgrade-backup')))
  // real sums still match the good tarballs (sanity)
  const want = (await sha256(join(BUNDLED, 'richdocuments-v9.2.3.tar.gz')))
  assert.equal(want, 'd62329cbe2e63c55e69edcb14e9fdecd743ad144446950c9496f3254c1eef7c8')
})

it('refuses to overwrite an existing backup when the stamp is pinned', () => {
  seedOldApps()
  const stamp = 'fixedstamp'
  const dest = join(dst, '.idea-upgrade-backup', `richdocuments-8.8.3-${stamp}`)
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'KEEP'), 'keep-me')
  const r = run({ IDEA_UPGRADE_BACKUP_TS: stamp })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /refusing to overwrite existing backup/)
  assert.match(r.stdout, /richdocuments-8\.8\.3-fixedstamp/)
  assert.equal(readFileSync(join(dest, 'KEEP'), 'utf8'), 'keep-me')
  // nothing moved: both old apps still in place
  assert.match(readFileSync(join(dst, 'richdocuments/appinfo/info.xml'), 'utf8'), /<version>8\.8\.3<\/version>/)
  assert.ok(existsSync(join(dst, 'richdocuments/OLD')))
})

it('does not touch a pre-existing backup with a different stamp', () => {
  seedOldApps()
  const other = join(dst, '.idea-upgrade-backup', 'richdocuments-8.8.3-older')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'KEEP'), 'untouched')
  const r = run({ IDEA_UPGRADE_BACKUP_TS: 'newstamp' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(readFileSync(join(other, 'KEEP'), 'utf8'), 'untouched')
  assert.ok(existsSync(join(dst, '.idea-upgrade-backup', 'richdocuments-8.8.3-newstamp', 'OLD')))
  assert.match(readFileSync(join(dst, 'richdocuments/appinfo/info.xml'), 'utf8'), /<version>9\.2\.3<\/version>/)
})

it('idea_usage 1.0.0 with max-version 31 is not treated as already current (version alone is not enough)', () => {
  writeInfo(join(dst, 'idea_usage'), '1.0.0', '31')
  writeFileSync(join(dst, 'idea_usage', 'OLD'), 'old')
  // only ship idea_usage so the run is about this app
  rmSync(join(src, 'richdocuments-v9.2.3.tar.gz'))
  const sums = readFileSync(join(src, 'SHA256SUMS'), 'utf8').split('\n').filter(l => l.includes('idea_usage')).join('\n') + '\n'
  writeFileSync(join(src, 'SHA256SUMS'), sums)
  const r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /backed up idea_usage 1\.0\.0/)
  assert.match(readFileSync(join(dst, 'idea_usage/appinfo/info.xml'), 'utf8'), /max-version="32"/)
  assert.ok(!existsSync(join(dst, 'idea_usage/OLD')))
})
