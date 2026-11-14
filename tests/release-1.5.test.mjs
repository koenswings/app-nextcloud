/**
 * Release 1.5-31.0.1: version wiring and pins (idea#464). Run: node --test tests/
 * check-compose: set AAD_CHECK_COMPOSE to agent-app-dev script/check-compose.mjs to also run it.
 */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const VER = '1.5-31.0.1'
const compose = readFileSync(join(root, 'compose.yaml'), 'utf8')
const appYaml = readFileSync(join(root, 'app.yaml'), 'utf8')

it('x-app.version and every service x-app-version label are 1.5-31.0.1', () => {
  assert.match(compose, /^  version: "1\.5-31\.0\.1"$/m)
  const labels = [...compose.matchAll(/^      x-app-version: "([^"]+)"$/gm)].map(m => m[1])
  assert.deepEqual(labels, [VER, VER, VER])
})

it('image pins unchanged since 1.2 (digest-pinned, no rebuild)', () => {
  const imgs = [...compose.matchAll(/^    image: (\S+)$/gm)].map(m => m[1])
  assert.deepEqual(imgs, [
    'koenswings/nextcloud:1.0-31.0.1@sha256:3fcd398e8e9b0d46cc84ecebe70a95b4ad97ffd85f974419376d7ddd68a1823d',
    'koenswings/nextcloud-mariadb:1.0-11.7.2-MariaDB-ubu2404@sha256:53097b4b57324f966a7d718bb4bbaff8b8bad626cb677ea46b9a0c12cc53d412',
    'koenswings/nextcloud-code:1.0-24.04.13.2@sha256:8ca1ed448f542feaf2aed81e475520724db5231a15f46e002275f5255d2a447d',
  ])
})

it('app.yaml: engine_tested is set from the on-Pi check, idea_app_version unchanged', () => {
  assert.match(appYaml, /engine_tested:\n    commit: "431ab4c"\n    version: "1\.0"\n    date: "2026-11-14"/)
  assert.match(appYaml, /^idea_app_version: "1\.0"$/m)
})

it('release notes name 1.5-31.0.1', () => {
  const notes = readFileSync(join(root, 'docs/releases.md'), 'utf8')
  assert.match(notes, /^## 1\.5-31\.0\.1$/m)
  assert.match(notes, /before `maintenance:install`/, '#23: skeleton config in place before install')
  assert.ok(existsSync(join(root, 'config/idea-skeleton.config.php')), '#23 config file ships in the release')
})

it('agent-app-dev check-compose --tag 1.5-31.0.1 (when AAD_CHECK_COMPOSE is set)', { skip: !process.env.AAD_CHECK_COMPOSE || !existsSync(process.env.AAD_CHECK_COMPOSE) }, () => {
  const r = spawnSync('node', [process.env.AAD_CHECK_COMPOSE, '--tag', VER, join(root, 'compose.yaml')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
