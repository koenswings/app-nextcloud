/**
 * Draft release 5.0-35.0.3: version wiring, official Nextcloud 35 pin,
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
const VER = '5.0-35.0.3'
const NC_PIN = 'nextcloud:35.0.3-apache@sha256:8a7a65b8bae82a79568fec2ed9cf3e374a1944eda2a22ebe130d79463336fee3'
const MARIADB_PIN = 'koenswings/nextcloud-mariadb:1.0-11.7.2-MariaDB-ubu2404@sha256:53097b4b57324f966a7d718bb4bbaff8b8bad626cb677ea46b9a0c12cc53d412'
const CODE_PIN = 'koenswings/nextcloud-code:1.0-24.04.13.2@sha256:8ca1ed448f542feaf2aed81e475520724db5231a15f46e002275f5255d2a447d'
const IDEA_USAGE_SHA = 'e01115a28544d59fcce8279d98fda8072b6e2d2531d617f4d2da63016b590084'
const RICHDOCUMENTS_SHA = '5deacee4fa1bb8eb7068e86c6dadbdaf0e44f8c79df0298a2254f562e3ed949b'
const compose = readFileSync(join(root, 'compose.yaml'), 'utf8')
const appYaml = readFileSync(join(root, 'app.yaml'), 'utf8')

const hash = (name) => new Promise((resolve, reject) => {
  const h = createHash('sha256')
  createReadStream(join(root, 'bundled-apps', name))
    .on('data', (c) => h.update(c))
    .on('error', reject)
    .on('end', () => resolve(h.digest('hex')))
})

it('x-app.version and every service x-app-version label are 5.0-35.0.3', () => {
  assert.match(compose, /^  version: "5\.0-35\.0\.3"$/m)
  const labels = [...compose.matchAll(/^      x-app-version: "([^"]+)"$/gm)].map(m => m[1])
  assert.deepEqual(labels, [VER, VER, VER])
})

it('nextcloud-app is pinned to the official 35.0.3-apache index; MariaDB and CODE unchanged', () => {
  const imgs = [...compose.matchAll(/^    image: (\S+)$/gm)].map(m => m[1])
  assert.deepEqual(imgs, [NC_PIN, MARIADB_PIN, CODE_PIN])
  assert.match(compose, /koenswings\/nextcloud:5\.0-35\.0\.3/)
})

it('updatesFrom lists App major 4 only (the 4.x line, including 4.0); healthTimeout and start_period are 600 s', () => {
  assert.match(compose, /^  updatesFrom: \[4\]$/m)
  assert.doesNotMatch(compose, /^  updatesFrom: \[[123]/)
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
  assert.match(compose, /^      - IDEA_APP_VERSION=5\.0-35\.0\.3$/m)
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
  assert.match(targets, /^5\.0-35\.0\.3\t12\.0\.2\t1\.0\.0$/m)
  const settleSrc = readFileSync(settle, 'utf8')
  const settleBody = settleSrc.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
  assert.ok(!/cron\.php/.test(settleBody), 'settle must not run cron.php')
  const workSrc = readFileSync(work, 'utf8')
  assert.match(workSrc, /cron\.php/)
})

it('app.yaml: engine_tested left at the 1.7 Pi check (Pi proof pending)', () => {
  assert.match(appYaml, /engine_tested:\n    commit: "cba91a6"\n    version: "1\.0"\n    date: "2026-11-15"/)
})

it('bundled-apps SHA256SUMS pin idea_usage 1.0.0 and richdocuments 12.0.2, and the tarballs match', async () => {
  const sums = readFileSync(join(root, 'bundled-apps/SHA256SUMS'), 'utf8')
  assert.match(sums, new RegExp(`^${IDEA_USAGE_SHA}  idea_usage-v1\\.0\\.0\\.tar\\.gz$`, 'm'))
  assert.match(sums, new RegExp(`^${RICHDOCUMENTS_SHA}  richdocuments-v12\\.0\\.2\\.tar\\.gz$`, 'm'))
  assert.doesNotMatch(sums, /richdocuments-v10\.3\.3/)
  assert.doesNotMatch(sums, /richdocuments-v9\.2\.3/)
  assert.doesNotMatch(sums, /richdocuments-v8\.8\.3/)
  assert.equal(await hash('idea_usage-v1.0.0.tar.gz'), IDEA_USAGE_SHA)
  assert.equal(await hash('richdocuments-v12.0.2.tar.gz'), RICHDOCUMENTS_SHA)
})

it('richdocuments 12.0.2 is Nextcloud 35-only (PHP >= 8.3); idea_usage 1.0.0 allows 31–35', () => {
  const ideaUsage = readFileSync(join(root, 'idea_usage/appinfo/info.xml'), 'utf8')
  assert.match(ideaUsage, /<version>1\.0\.0<\/version>/)
  assert.match(ideaUsage, /<nextcloud min-version="31" max-version="35"\/>/)
  const r = spawnSync('tar', ['-xOf', join(root, 'bundled-apps/richdocuments-v12.0.2.tar.gz'), 'richdocuments/appinfo/info.xml'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /<version>12\.0\.2<\/version>/)
  assert.match(r.stdout, /<nextcloud min-version="35" max-version="35"\/>/)
  assert.match(r.stdout, /<php min-version="8\.3"\/>/)
})

it('release notes mark 5.0-35.0.3 as DRAFT and keep 4.0-34.0.6, 3.0-33.0.11, 2.0-32.0.15 and 1.8-31.0.14', () => {
  const notes = readFileSync(join(root, 'docs/releases.md'), 'utf8')
  assert.match(notes, /^## 5\.0-35\.0\.3$/m)
  assert.match(notes, /DRAFT/)
  assert.match(notes, /35\.0\.3-apache/, '5.0: Nextcloud 35 hop')
  assert.match(notes, /8a7a65b8bae82a79568fec2ed9cf3e374a1944eda2a22ebe130d79463336fee3/, '5.0: upstream index digest')
  assert.match(notes, /richdocuments` 12\.0\.2/)
  assert.match(notes, /x-app\.update\.prepare/)
  assert.match(notes, /x-app\.update\.verify/)
  assert.match(notes, /x-app\.update\.work/)
  assert.match(notes, /x-app\.update\.settle/)
  assert.match(notes, /\*\*Database:\*\* no database image upgrade in this release/, '5.0: DB change stated explicitly (none)')
  assert.match(notes, /Pi proof\s+pending \(pool\s+reserved/)
  assert.match(notes, /updatesFrom: \[4\]/)
  assert.match(notes, /^## 4\.0-34\.0\.6$/m)
  assert.match(notes, /^## 3\.0-33\.0\.11$/m)
  assert.match(notes, /^## 2\.0-32\.0\.15$/m)
  assert.match(notes, /^## 1\.8-31\.0\.14$/m)
  assert.ok(existsSync(join(root, 'config/idea-skeleton.config.php')), 'skeleton config still ships')
})

it('MariaDB stays 11.7 (no DB image upgrade): inside the Nextcloud 35 setup-check range 10.11-12.3 (SupportedDatabase.php v35.0.3)', () => {
  const m = compose.match(/^    image: koenswings\/nextcloud-mariadb:1\.0-(\d+)\.(\d+)\.\d+-MariaDB/m)
  assert.ok(m, 'MariaDB pin')
  const v = Number(m[1]) * 100 + Number(m[2])
  assert.ok(v >= 1011 && v <= 1203, `MariaDB ${m[1]}.${m[2]} outside 10.11-12.3`)
  const notes = readFileSync(join(root, 'docs/releases.md'), 'utf8')
  assert.match(notes, /MariaDB 10\.11–12\.3/)
})

it('agent-app-dev check-compose --release --tag 5.0-35.0.3 (when AAD_CHECK_COMPOSE is set)', { skip: !process.env.AAD_CHECK_COMPOSE || !existsSync(process.env.AAD_CHECK_COMPOSE) }, () => {
  const r = spawnSync('node', [process.env.AAD_CHECK_COMPOSE, '--release', '--tag', VER, join(root, 'compose.yaml')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
