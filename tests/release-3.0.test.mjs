/**
 * Draft release 3.0-33.0.11: version wiring, official Nextcloud 33 pin,
 * bundled-app sums, Prepare/Verify/Work/Settle contract fields including user.
 * Run: node --test tests/
 * check-compose: set AAD_CHECK_COMPOSE to agent-app-dev script/check-compose.mjs to also run it.
 */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, createReadStream, accessSync, constants } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const VER = '3.0-33.0.11'
const NC_PIN = 'nextcloud:33.0.11-apache@sha256:3bbb8b04c6ea1b6687502802f9097fd9723797668a9dd6d0adcf4525b530f7a1'
const MARIADB_PIN = 'koenswings/nextcloud-mariadb:1.0-11.7.2-MariaDB-ubu2404@sha256:53097b4b57324f966a7d718bb4bbaff8b8bad626cb677ea46b9a0c12cc53d412'
const CODE_PIN = 'koenswings/nextcloud-code:1.0-24.04.13.2@sha256:8ca1ed448f542feaf2aed81e475520724db5231a15f46e002275f5255d2a447d'
const IDEA_USAGE_SHA = '61318cbc7d20063508525ec67a54f42152958d5dbe8589a00f8e3d3065f3b90e'
const RICHDOCUMENTS_SHA = '82a9e4c6fda4fd32a44587827cf9f68babbad370517b8a7a5f413e4f3c642528'
const compose = readFileSync(join(root, 'compose.yaml'), 'utf8')
const appYaml = readFileSync(join(root, 'app.yaml'), 'utf8')

const hash = (name) => new Promise((resolve, reject) => {
  const h = createHash('sha256')
  createReadStream(join(root, 'bundled-apps', name))
    .on('data', (c) => h.update(c))
    .on('error', reject)
    .on('end', () => resolve(h.digest('hex')))
})

it('x-app.version and every service x-app-version label are 3.0-33.0.11', () => {
  assert.match(compose, /^  version: "3\.0-33\.0\.11"$/m)
  const labels = [...compose.matchAll(/^      x-app-version: "([^"]+)"$/gm)].map(m => m[1])
  assert.deepEqual(labels, [VER, VER, VER])
})

it('nextcloud-app is pinned to the official 33.0.11-apache index; MariaDB and CODE unchanged', () => {
  const imgs = [...compose.matchAll(/^    image: (\S+)$/gm)].map(m => m[1])
  assert.deepEqual(imgs, [NC_PIN, MARIADB_PIN, CODE_PIN])
  assert.match(compose, /koenswings\/nextcloud:3\.0-33\.0\.11/)
})

it('updatesFrom lists App major 2 only (the 2.x line, including 2.0); healthTimeout and start_period are 600 s', () => {
  assert.match(compose, /^  updatesFrom: \[2\]$/m)
  assert.doesNotMatch(compose, /^  updatesFrom: \[1/)
  assert.match(compose, /^  healthTimeout: 600$/m)
  assert.match(compose, /^      start_period: 600s$/m)
})

it('x-app.update prepare/verify/work/settle match the addendum, with user 0 / 33, and the scripts are mounted executable', () => {
  assert.match(compose, /^  update:$/m)
  assert.match(compose, /^    prepare:\n      service: nextcloud-app\n      user: "0"\n      command: \/idea\/hooks\/prep-custom-apps-for-upgrade\.sh\n      timeout: 600$/m)
  assert.match(compose, /^    verify:\n      service: nextcloud-app\n      user: "33"\n      command: \/idea\/hooks\/verify-update\.sh\n      timeout: 120$/m)
  assert.match(compose, /^    work:\n      service: nextcloud-app\n      user: "33"\n      command: \/idea\/hooks\/work-update\.sh\n      timeout: 3600$/m)
  assert.match(compose, /^    settle:\n      service: nextcloud-app\n      user: "33"\n      command: \/idea\/hooks\/settle-update\.sh\n      interval: 60\n      timeout: 3600$/m)
  assert.match(compose, /- \.\/hooks:\/idea\/hooks:ro/)
  assert.match(compose, /^      - IDEA_APP_VERSION=3\.0-33\.0\.11$/m)
  const prep = join(root, 'hooks/prep-custom-apps-for-upgrade.sh')
  const verify = join(root, 'hooks/verify-update.sh')
  const work = join(root, 'hooks/work-update.sh')
  const settle = join(root, 'hooks/settle-update.sh')
  const lib = join(root, 'hooks/update-lib.sh')
  accessSync(prep, constants.X_OK)
  accessSync(verify, constants.X_OK)
  accessSync(work, constants.X_OK)
  accessSync(settle, constants.X_OK)
  accessSync(lib, constants.R_OK)
  const prepSrc = readFileSync(prep, 'utf8')
  const body = prepSrc.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
  assert.ok(!/\bocc\b/.test(body), 'prepare must not invoke occ')
  assert.ok(!/docker-entrypoint/.test(body), 'prepare must not invoke the image entrypoint')
  assert.match(body, /unexpected arguments/, 'prepare must refuse leftover argv')
  for (const f of [prep, verify, work, settle, lib]) {
    const src = readFileSync(f, 'utf8')
    assert.doesNotMatch(src, /ASSUMPTION: Engine gap \(10\)/)
  }
  const libSrc = readFileSync(lib, 'utf8')
  const libBody = libSrc.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
  assert.doesNotMatch(libBody, /runuser -u www-data/, 'in-script www-data fallback must be gone; user field is guaranteed')
  const targets = readFileSync(join(root, 'hooks/update-targets'), 'utf8')
  assert.match(targets, /^3\.0-33\.0\.11\t10\.3\.3\t1\.0\.0$/m)
  const settleSrc = readFileSync(settle, 'utf8')
  const settleBody = settleSrc.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
  assert.ok(!/cron\.php/.test(settleBody), 'settle must not run cron.php')
  const workSrc = readFileSync(work, 'utf8')
  assert.match(workSrc, /cron\.php/)
})

it('app.yaml: engine_tested left at the 1.7 Pi check (Pi proof pending)', () => {
  assert.match(appYaml, /engine_tested:\n    commit: "cba91a6"\n    version: "1\.0"\n    date: "2026-11-15"/)
})

it('bundled-apps SHA256SUMS pin idea_usage 1.0.0 and richdocuments 10.3.3, and the tarballs match', async () => {
  const sums = readFileSync(join(root, 'bundled-apps/SHA256SUMS'), 'utf8')
  assert.match(sums, new RegExp(`^${IDEA_USAGE_SHA}  idea_usage-v1\\.0\\.0\\.tar\\.gz$`, 'm'))
  assert.match(sums, new RegExp(`^${RICHDOCUMENTS_SHA}  richdocuments-v10\\.3\\.3\\.tar\\.gz$`, 'm'))
  assert.doesNotMatch(sums, /richdocuments-v9\.2\.3/)
  assert.doesNotMatch(sums, /richdocuments-v8\.8\.3/)
  assert.equal(await hash('idea_usage-v1.0.0.tar.gz'), IDEA_USAGE_SHA)
  assert.equal(await hash('richdocuments-v10.3.3.tar.gz'), RICHDOCUMENTS_SHA)
})

it('richdocuments 10.3.3 is Nextcloud 33-only; idea_usage 1.0.0 allows 31–33', () => {
  const ideaUsage = readFileSync(join(root, 'idea_usage/appinfo/info.xml'), 'utf8')
  assert.match(ideaUsage, /<version>1\.0\.0<\/version>/)
  assert.match(ideaUsage, /<nextcloud min-version="31" max-version="33"\/>/)
  const r = spawnSync('tar', ['-xOf', join(root, 'bundled-apps/richdocuments-v10.3.3.tar.gz'), 'richdocuments/appinfo/info.xml'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /<version>10\.3\.3<\/version>/)
  assert.match(r.stdout, /<nextcloud min-version="33" max-version="33"\/>/)
})

it('release notes mark 3.0-33.0.11 as DRAFT and keep 2.0-32.0.15 and 1.8-31.0.14', () => {
  const notes = readFileSync(join(root, 'docs/releases.md'), 'utf8')
  assert.match(notes, /^## 3\.0-33\.0\.11$/m)
  assert.match(notes, /DRAFT/)
  assert.match(notes, /33\.0\.11-apache/, '3.0: Nextcloud 33 hop')
  assert.match(notes, /3bbb8b04c6ea1b6687502802f9097fd9723797668a9dd6d0adcf4525b530f7a1/, '3.0: upstream index digest')
  assert.match(notes, /richdocuments` 10\.3\.3/)
  assert.match(notes, /x-app\.update\.prepare/)
  assert.match(notes, /x-app\.update\.verify/)
  assert.match(notes, /x-app\.update\.work/)
  assert.match(notes, /x-app\.update\.settle/)
  assert.match(notes, /\*\*Database:\*\* no database image upgrade in this release/, '3.0: DB change stated explicitly (none)')
  assert.match(notes, /Pi proof\s+pending \(pool\s+reserved/)
  assert.match(notes, /updatesFrom: \[2\]/)
  assert.match(notes, /^## 2\.0-32\.0\.15$/m)
  assert.match(notes, /^## 1\.8-31\.0\.14$/m)
  assert.ok(existsSync(join(root, 'config/idea-skeleton.config.php')), 'skeleton config still ships')
})

it('agent-app-dev check-compose --release --tag 3.0-33.0.11 (when AAD_CHECK_COMPOSE is set)', { skip: !process.env.AAD_CHECK_COMPOSE || !existsSync(process.env.AAD_CHECK_COMPOSE) }, () => {
  const r = spawnSync('node', [process.env.AAD_CHECK_COMPOSE, '--release', '--tag', VER, join(root, 'compose.yaml')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
