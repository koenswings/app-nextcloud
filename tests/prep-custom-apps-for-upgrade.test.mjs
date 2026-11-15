/**
 * Unit tests for hooks/prep-custom-apps-for-upgrade.sh. No Docker: a temp dir
 * stands in for ./data/nextcloud/custom_apps and ./bundled-apps.
 * Versions come from the shipped tarballs, so the same tests serve 2.0 / 3.0 / 4.0.
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
const rdTarball = readdirSync(BUNDLED).find(f => /^richdocuments-v.+\.tar\.gz$/.test(f))
const usageTarball = readdirSync(BUNDLED).find(f => /^idea_usage-v.+\.tar\.gz$/.test(f))
assert.ok(rdTarball, 'bundled-apps must ship a richdocuments tarball')
assert.ok(usageTarball, 'bundled-apps must ship an idea_usage tarball')
const RD_VER = rdTarball.match(/^richdocuments-v(.+)\.tar\.gz$/)[1]
const USAGE_VER = usageTarball.match(/^idea_usage-v(.+)\.tar\.gz$/)[1]
const xmlFromTar = (tarball, app) => {
  const r = spawnSync('tar', ['-xOf', join(BUNDLED, tarball), `${app}/appinfo/info.xml`], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const ver = r.stdout.match(/<version>([^<]+)<\/version>/)
  const max = r.stdout.match(/max-version="([^"]+)"/)
  assert.ok(ver && max, r.stdout)
  return { ver: ver[1], max: max[1] }
}
const RD = xmlFromTar(rdTarball, 'richdocuments')
const USAGE = xmlFromTar(usageTarball, 'idea_usage')
assert.equal(RD.ver, RD_VER)
assert.equal(USAGE.ver, USAGE_VER)
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
  writeInfo(join(dst, 'richdocuments'), '0.0.1', '31')
  writeFileSync(join(dst, 'richdocuments', 'OLD'), 'old-richdocuments')
  writeInfo(join(dst, 'idea_usage'), USAGE_VER, '31')
  writeFileSync(join(dst, 'idea_usage', 'OLD'), 'old-usage')
}

const envFor = (extra = {}) => ({
  PATH: process.env.PATH,
  IDEA_BUNDLED_APPS: src,
  IDEA_CUSTOM_APPS: dst,
  ...extra,
})

const run = (extra = {}, args = []) => spawnSync(SCRIPT, args, { encoding: 'utf8', env: envFor(extra) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'idea-prep-'))
  src = join(dir, 'bundled-apps')
  dst = join(dir, 'data', 'nextcloud', 'custom_apps')
  mkdirSync(src, { recursive: true })
  mkdirSync(dst, { recursive: true })
  for (const f of [usageTarball, rdTarball, 'SHA256SUMS']) {
    cpSync(join(BUNDLED, f), join(src, f))
  }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it(`replaces an older tree, backs it up, and extracts richdocuments ${RD_VER} and idea_usage max-version ${USAGE.max}`, () => {
  seedOldApps()
  const r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, new RegExp(`backed up richdocuments 0\\.0\\.1`))
  assert.match(r.stdout, new RegExp(`installed richdocuments ${RD_VER.replace(/\./g, '\\.')}`))
  assert.match(r.stdout, /backed up idea_usage /)
  assert.match(r.stdout, new RegExp(`installed idea_usage ${USAGE_VER.replace(/\./g, '\\.')} \\(max-version ${USAGE.max}\\)`))
  const rd = readFileSync(join(dst, 'richdocuments/appinfo/info.xml'), 'utf8')
  assert.match(rd, new RegExp(`<version>${RD_VER.replace(/\./g, '\\.')}</version>`))
  assert.match(rd, new RegExp(`max-version="${RD.max}"`))
  assert.ok(!existsSync(join(dst, 'richdocuments/OLD')))
  const usage = readFileSync(join(dst, 'idea_usage/appinfo/info.xml'), 'utf8')
  assert.match(usage, new RegExp(`<version>${USAGE_VER.replace(/\./g, '\\.')}</version>`))
  assert.match(usage, new RegExp(`max-version="${USAGE.max}"`))
  assert.ok(!existsSync(join(dst, 'idea_usage/OLD')))
  const backup = join(dst, '.idea-upgrade-backup')
  const names = readdirSync(backup).sort()
  const rdBak = names.find(n => n.startsWith('richdocuments-0.0.1-'))
  const usBak = names.find(n => n.startsWith(`idea_usage-${USAGE_VER}-`))
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
  assert.match(r.stdout, new RegExp(`richdocuments already at ${RD_VER.replace(/\./g, '\\.')}`))
  assert.match(r.stdout, new RegExp(`idea_usage already at ${USAGE_VER.replace(/\./g, '\\.')} \\(max-version ${USAGE.max}\\)`))
  assert.doesNotMatch(r.stdout, /backed up/)
  assert.deepEqual(readdirSync(backup).sort(), first)
  assert.equal(statSync(join(dst, 'richdocuments/appinfo/info.xml')).mtimeMs, rdMtime)
  assert.match(readFileSync(join(dst, 'richdocuments/appinfo/info.xml'), 'utf8'), new RegExp(`<version>${RD_VER.replace(/\./g, '\\.')}</version>`))
})

it('checksum mismatch exits non-zero and leaves existing apps untouched', async () => {
  seedOldApps()
  writeFileSync(join(src, 'SHA256SUMS'),
    `${'0'.repeat(64)}  ${usageTarball}\n${'0'.repeat(64)}  ${rdTarball}\n`)
  const r = run()
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /ERROR: .* checksum mismatch/)
  assert.match(readFileSync(join(dst, 'richdocuments/appinfo/info.xml'), 'utf8'), /<version>0\.0\.1<\/version>/)
  assert.match(readFileSync(join(dst, 'idea_usage/appinfo/info.xml'), 'utf8'), /max-version="31"/)
  assert.ok(existsSync(join(dst, 'richdocuments/OLD')))
  assert.ok(!existsSync(join(dst, '.idea-upgrade-backup')))
  const want = (await sha256(join(BUNDLED, rdTarball)))
  const sums = readFileSync(join(BUNDLED, 'SHA256SUMS'), 'utf8')
  assert.match(sums, new RegExp(`^${want}  ${rdTarball.replace(/\./g, '\\.')}$`, 'm'))
})

it('refuses to overwrite an existing backup when the stamp is pinned', () => {
  seedOldApps()
  const stamp = 'fixedstamp'
  const dest = join(dst, '.idea-upgrade-backup', `richdocuments-0.0.1-${stamp}`)
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'KEEP'), 'keep-me')
  const r = run({ IDEA_UPGRADE_BACKUP_TS: stamp })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /refusing to overwrite existing backup/)
  assert.match(r.stdout, /richdocuments-0\.0\.1-fixedstamp/)
  assert.equal(readFileSync(join(dest, 'KEEP'), 'utf8'), 'keep-me')
  assert.match(readFileSync(join(dst, 'richdocuments/appinfo/info.xml'), 'utf8'), /<version>0\.0\.1<\/version>/)
  assert.ok(existsSync(join(dst, 'richdocuments/OLD')))
})

it('does not touch a pre-existing backup with a different stamp', () => {
  seedOldApps()
  const other = join(dst, '.idea-upgrade-backup', 'richdocuments-0.0.1-older')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'KEEP'), 'untouched')
  const r = run({ IDEA_UPGRADE_BACKUP_TS: 'newstamp' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(readFileSync(join(other, 'KEEP'), 'utf8'), 'untouched')
  assert.ok(existsSync(join(dst, '.idea-upgrade-backup', 'richdocuments-0.0.1-newstamp', 'OLD')))
  assert.match(readFileSync(join(dst, 'richdocuments/appinfo/info.xml'), 'utf8'), new RegExp(`<version>${RD_VER.replace(/\./g, '\\.')}</version>`))
})

it(`idea_usage ${USAGE_VER} with max-version 31 is not treated as already current (version alone is not enough)`, () => {
  writeInfo(join(dst, 'idea_usage'), USAGE_VER, '31')
  writeFileSync(join(dst, 'idea_usage', 'OLD'), 'old')
  rmSync(join(src, rdTarball))
  const sums = readFileSync(join(src, 'SHA256SUMS'), 'utf8').split('\n').filter(l => l.includes('idea_usage')).join('\n') + '\n'
  writeFileSync(join(src, 'SHA256SUMS'), sums)
  const r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, new RegExp(`backed up idea_usage ${USAGE_VER.replace(/\./g, '\\.')}`))
  assert.match(readFileSync(join(dst, 'idea_usage/appinfo/info.xml'), 'utf8'), new RegExp(`max-version="${USAGE.max}"`))
  assert.ok(!existsSync(join(dst, 'idea_usage/OLD')))
})

it('refuses leftover argv (Engine must pass an empty command)', () => {
  seedOldApps()
  const r = run({}, ['apache2-foreground'])
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /ERROR: unexpected arguments: apache2-foreground/)
  assert.match(readFileSync(join(dst, 'richdocuments/appinfo/info.xml'), 'utf8'), /<version>0\.0\.1<\/version>/)
  assert.ok(existsSync(join(dst, 'richdocuments/OLD')))
})
