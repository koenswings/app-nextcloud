/**
 * Release 1.8-31.0.14: version wiring, upstream Nextcloud pin, bundled-app sums.
 * Run: node --test tests/
 * check-compose: set AAD_CHECK_COMPOSE to agent-app-dev script/check-compose.mjs to also run it.
 */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, createReadStream } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const VER = '1.8-31.0.14'
const NC_PIN = 'nextcloud:31.0.14-apache@sha256:07ec73cc816e58d6f45a162cd53ef886462c29271a23fc68d0124cec276e3767'
const MARIADB_PIN = 'koenswings/nextcloud-mariadb:1.0-11.7.2-MariaDB-ubu2404@sha256:53097b4b57324f966a7d718bb4bbaff8b8bad626cb677ea46b9a0c12cc53d412'
const CODE_PIN = 'koenswings/nextcloud-code:1.0-24.04.13.2@sha256:8ca1ed448f542feaf2aed81e475520724db5231a15f46e002275f5255d2a447d'
const IDEA_USAGE_SHA = 'd50e96c57a5326c3414a726152df3c6f6af1503a3d122df1269e2c6965ba92fe'
const RICHDOCUMENTS_SHA = 'cbe98fe258a80680b6f15fa1f9301ceedf3521db66d431a79d47ef7f100a3d7e'
const compose = readFileSync(join(root, 'compose.yaml'), 'utf8')
const appYaml = readFileSync(join(root, 'app.yaml'), 'utf8')

it('x-app.version and every service x-app-version label are 1.8-31.0.14', () => {
  assert.match(compose, /^  version: "1\.8-31\.0\.14"$/m)
  const labels = [...compose.matchAll(/^      x-app-version: "([^"]+)"$/gm)].map(m => m[1])
  assert.deepEqual(labels, [VER, VER, VER])
})

it('nextcloud-app is pinned to the official 31.0.14-apache index; MariaDB and CODE unchanged', () => {
  const imgs = [...compose.matchAll(/^    image: (\S+)$/gm)].map(m => m[1])
  assert.deepEqual(imgs, [NC_PIN, MARIADB_PIN, CODE_PIN])
})

it('app.yaml: engine_tested left at the 1.7 Pi check (Pi proof pending)', () => {
  assert.match(appYaml, /engine_tested:\n    commit: "cba91a6"\n    version: "1\.0"\n    date: "2026-11-15"/)
})

it('bundled-apps SHA256SUMS still pin idea_usage 1.0.0 and richdocuments 8.8.3, and the tarballs match', async () => {
  const sums = readFileSync(join(root, 'bundled-apps/SHA256SUMS'), 'utf8')
  assert.match(sums, new RegExp(`^${IDEA_USAGE_SHA}  idea_usage-v1\\.0\\.0\\.tar\\.gz$`, 'm'))
  assert.match(sums, new RegExp(`^${RICHDOCUMENTS_SHA}  richdocuments-v8\\.8\\.3\\.tar\\.gz$`, 'm'))
  const hash = (name) => new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(join(root, 'bundled-apps', name))
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
  assert.equal(await hash('idea_usage-v1.0.0.tar.gz'), IDEA_USAGE_SHA)
  assert.equal(await hash('richdocuments-v8.8.3.tar.gz'), RICHDOCUMENTS_SHA)
})

it('richdocuments 8.8.3 and idea_usage 1.0.0 both allow Nextcloud 31 (covers 31.0.14)', () => {
  const ideaUsage = readFileSync(join(root, 'idea_usage/appinfo/info.xml'), 'utf8')
  assert.match(ideaUsage, /<nextcloud min-version="31" max-version="31"\/>/)
  const r = spawnSync('tar', ['-xOf', join(root, 'bundled-apps/richdocuments-v8.8.3.tar.gz'), '--wildcards', '*/appinfo/info.xml'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /<version>8\.8\.3<\/version>/)
  assert.match(r.stdout, /<nextcloud min-version="31" max-version="31"\/>/)
})

it('release notes name 1.8-31.0.14 and keep 1.7-31.0.1, 1.6-31.0.1 and 1.5-31.0.1', () => {
  const notes = readFileSync(join(root, 'docs/releases.md'), 'utf8')
  assert.match(notes, /^## 1\.8-31\.0\.14$/m)
  assert.match(notes, /31\.0\.14-apache/, '1.8: Nextcloud point update')
  assert.match(notes, /07ec73cc816e58d6f45a162cd53ef886462c29271a23fc68d0124cec276e3767/, '1.8: upstream index digest')
  assert.match(notes, /Pi proof pending/)
  assert.match(notes, /^## 1\.7-31\.0\.1$/m)
  assert.match(notes, /app-nextcloud#29/, '1.7: healthcheck during backup maintenance')
  assert.match(notes, /^## 1\.6-31\.0\.1$/m)
  assert.match(notes, /x-app\.backup/, '1.6: live backup hook')
  assert.match(notes, /^## 1\.5-31\.0\.1$/m)
  assert.match(notes, /before `maintenance:install`/, '#23: skeleton config in place before install')
  assert.ok(existsSync(join(root, 'config/idea-skeleton.config.php')), '#23 config file ships in the release')
})

it('agent-app-dev check-compose --release --tag 1.8-31.0.14 (when AAD_CHECK_COMPOSE is set)', { skip: !process.env.AAD_CHECK_COMPOSE || !existsSync(process.env.AAD_CHECK_COMPOSE) }, () => {
  const r = spawnSync('node', [process.env.AAD_CHECK_COMPOSE, '--release', '--tag', VER, join(root, 'compose.yaml')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
