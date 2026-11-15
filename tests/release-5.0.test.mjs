/**
 * Draft release 5.0-34.0.6 (database-only App major): MariaDB 11.7.2 -> 11.8.9 on Nextcloud 34.0.6,
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
const VER = '5.0-34.0.6'
const NC_PIN = 'nextcloud:34.0.6-apache@sha256:3031e7f87baaceb863a755921ebf463bc26ea71855c07ad7858e2ae25a5a0ad7'
const MARIADB_PIN = 'mariadb:11.8.9-noble@sha256:d36f18d65a0459510b8b0f643b226a6d299e3206486e2b64ff20754a6d291707'
const CODE_PIN = 'koenswings/nextcloud-code:1.0-24.04.13.2@sha256:8ca1ed448f542feaf2aed81e475520724db5231a15f46e002275f5255d2a447d'
const IDEA_USAGE_SHA = 'de01e23f09dee1a1c14f8a58bdba1ef2968dce4d80c841c7e2276f6a54316ae9'
const RICHDOCUMENTS_SHA = 'f6d25946904eeae26107f9fa7c38a45daa6b6df159a5fb5bfdf46735f61cd29d'
const compose = readFileSync(join(root, 'compose.yaml'), 'utf8')
const appYaml = readFileSync(join(root, 'app.yaml'), 'utf8')

const hash = (name) => new Promise((resolve, reject) => {
  const h = createHash('sha256')
  createReadStream(join(root, 'bundled-apps', name))
    .on('data', (c) => h.update(c))
    .on('error', reject)
    .on('end', () => resolve(h.digest('hex')))
})

it('x-app.version and every service x-app-version label are 5.0-34.0.6', () => {
  assert.match(compose, /^  version: "5\.0-34\.0\.6"$/m)
  const labels = [...compose.matchAll(/^      x-app-version: "([^"]+)"$/gm)].map(m => m[1])
  assert.deepEqual(labels, [VER, VER, VER])
})

it('nextcloud-app stays on the official 34.0.6-apache index; MariaDB moves to official 11.8.9-noble; CODE unchanged', () => {
  const imgs = [...compose.matchAll(/^    image: (\S+)$/gm)].map(m => m[1])
  assert.deepEqual(imgs, [NC_PIN, MARIADB_PIN, CODE_PIN])
  assert.match(compose, /koenswings\/nextcloud:5\.0-34\.0\.6/)
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
  assert.match(compose, /^      - IDEA_APP_VERSION=5\.0-34\.0\.6$/m)
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
  assert.match(targets, /^5\.0-34\.0\.6\t11\.1\.3\t1\.0\.0$/m)
  const settleSrc = readFileSync(settle, 'utf8')
  const settleBody = settleSrc.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
  assert.ok(!/cron\.php/.test(settleBody), 'settle must not run cron.php')
  const workSrc = readFileSync(work, 'utf8')
  assert.match(workSrc, /cron\.php/)
})

it('app.yaml: engine_tested left at the 1.7 Pi check (Pi proof pending)', () => {
  assert.match(appYaml, /engine_tested:\n    commit: "cba91a6"\n    version: "1\.0"\n    date: "2026-11-15"/)
})

it('bundled-apps SHA256SUMS pin idea_usage 1.0.0 and richdocuments 11.1.3, and the tarballs match', async () => {
  const sums = readFileSync(join(root, 'bundled-apps/SHA256SUMS'), 'utf8')
  assert.match(sums, new RegExp(`^${IDEA_USAGE_SHA}  idea_usage-v1\\.0\\.0\\.tar\\.gz$`, 'm'))
  assert.match(sums, new RegExp(`^${RICHDOCUMENTS_SHA}  richdocuments-v11\\.1\\.3\\.tar\\.gz$`, 'm'))
  assert.doesNotMatch(sums, /richdocuments-v10\.3\.3/)
  assert.doesNotMatch(sums, /richdocuments-v9\.2\.3/)
  assert.doesNotMatch(sums, /richdocuments-v8\.8\.3/)
  assert.equal(await hash('idea_usage-v1.0.0.tar.gz'), IDEA_USAGE_SHA)
  assert.equal(await hash('richdocuments-v11.1.3.tar.gz'), RICHDOCUMENTS_SHA)
})

it('richdocuments 11.1.3 is Nextcloud 34-only; idea_usage 1.0.0 allows 31–34', () => {
  const ideaUsage = readFileSync(join(root, 'idea_usage/appinfo/info.xml'), 'utf8')
  assert.match(ideaUsage, /<version>1\.0\.0<\/version>/)
  assert.match(ideaUsage, /<nextcloud min-version="31" max-version="34"\/>/)
  const r = spawnSync('tar', ['-xOf', join(root, 'bundled-apps/richdocuments-v11.1.3.tar.gz'), 'richdocuments/appinfo/info.xml'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /<version>11\.1\.3<\/version>/)
  assert.match(r.stdout, /<nextcloud min-version="34" max-version="34"\/>/)
})

it('release notes mark 5.0-34.0.6 as DRAFT, name the MariaDB 11.7 -> 11.8 upgrade, and keep 4.0, 3.0, 2.0 and 1.8', () => {
  const notes = readFileSync(join(root, 'docs/releases.md'), 'utf8')
  assert.match(notes, /^## 5\.0-34\.0\.6$/m)
  assert.match(notes, /DRAFT/)
  assert.match(notes, /34\.0\.6-apache/, '5.0: Nextcloud stays 34.0.6')
  assert.match(notes, /3031e7f87baaceb863a755921ebf463bc26ea71855c07ad7858e2ae25a5a0ad7/, '5.0: Nextcloud index digest unchanged')
  assert.match(notes, /richdocuments` 11\.1\.3/)
  assert.match(notes, /x-app\.update\.prepare/)
  assert.match(notes, /x-app\.update\.verify/)
  assert.match(notes, /x-app\.update\.work/)
  assert.match(notes, /x-app\.update\.settle/)
  assert.match(notes, /\*\*Database:\*\* MariaDB 11\.7\.2 → 11\.8\.9/, '5.0: DB upgrade named explicitly')
  assert.match(notes, /no change to Nextcloud or the App itself/, '5.0: database-only major (agent-app-dev rule)')
  assert.match(notes, /--allow-major/, '5.0: offered with --allow-major')
  assert.match(notes, /NEEDS_BACKUP/, '5.0: Backup Disk required first')
  assert.match(notes, /cannot go back to 11\.7 in place \(no downgrade\)/, '5.0: irreversible data files')
  assert.match(notes, /mariadb-upgrade/, '5.0: names the upgrade step')
  assert.match(notes, /ROLLBACK FAILED/, '5.0: rollback behaviour')
  assert.match(notes, /Downtime:\*\* not yet measured/, '5.0: downtime pending proof')
  assert.match(notes, /41ba677/, '5.0: Engine 41ba677+ refuses because stages are declared')
  assert.match(notes, /UPDATE_STAGES_UNSUPPORTED/)
  assert.match(notes, /80ba4af/, '5.0: Pi proof on pre-#463 80ba4af is valid (stages are no-ops)')
  assert.match(notes, /#456 L/)
  assert.match(notes, /d36f18d65a0459510b8b0f643b226a6d299e3206486e2b64ff20754a6d291707/, '5.0: MariaDB index digest')
  assert.match(notes, /updatesFrom: \[4\]/)
  assert.match(notes, /^## 4\.0-34\.0\.6$/m)
  assert.match(notes, /^## 3\.0-33\.0\.11$/m)
  assert.match(notes, /^## 2\.0-32\.0\.15$/m)
  assert.match(notes, /^## 1\.8-31\.0\.14$/m)
  assert.ok(existsSync(join(root, 'config/idea-skeleton.config.php')), 'skeleton config still ships')
})

it('MariaDB 11.8 upgrade path: MARIADB_AUTO_UPGRADE=1 kept, db healthcheck start_period 900 s, same backup hooks', () => {
  assert.match(compose, /^      - MARIADB_AUTO_UPGRADE=1$/m)
  assert.match(compose, /^      start_period: 900s$/m)
  assert.match(compose, /- \.\/hooks\/backup-db-dump\.sh:\/idea\/backup\/db-dump\.sh:ro/)
  assert.doesNotMatch(compose, /nextcloud-mariadb:1\.0-11\.7/)
})

it('agent-app-dev check-compose --release --tag 5.0-34.0.6 (when AAD_CHECK_COMPOSE is set)', { skip: !process.env.AAD_CHECK_COMPOSE || !existsSync(process.env.AAD_CHECK_COMPOSE) }, () => {
  const r = spawnSync('node', [process.env.AAD_CHECK_COMPOSE, '--release', '--tag', VER, join(root, 'compose.yaml')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
