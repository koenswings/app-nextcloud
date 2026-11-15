/**
 * Release 5.0-34.0.6 (MariaDB 11.8, database-only) is now history: this tree is 6.0-35.0.3.
 * Keep the 5.0 notes in docs/releases.md. Live compose / tarball pins live in
 * tests/release-6.0.test.mjs.
 * Run: node --test tests/
 */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

it('release notes still document 5.0-34.0.6 (MariaDB 11.7.2 -> 11.8.9) as the previous release', () => {
  const notes = readFileSync(join(root, 'docs/releases.md'), 'utf8')
  assert.match(notes, /^## 5\.0-34\.0\.6$/m)
  assert.match(notes, /\*\*Database:\*\* MariaDB 11\.7\.2 → 11\.8\.9/, '5.0: DB upgrade named explicitly')
  assert.match(notes, /no change to Nextcloud or the App itself/)
  assert.match(notes, /d36f18d65a0459510b8b0f643b226a6d299e3206486e2b64ff20754a6d291707/, '5.0: MariaDB index digest')
  assert.ok(existsSync(join(root, 'config/idea-skeleton.config.php')), 'skeleton config still ships')
})

it('live compose is no longer 5.0-34.0.6 (superseded by 6.0); MariaDB 11.8.9 is kept', () => {
  const compose = readFileSync(join(root, 'compose.yaml'), 'utf8')
  assert.doesNotMatch(compose, /^  version: "5\.0-34\.0\.6"$/m)
  assert.doesNotMatch(compose, /nextcloud:34\.0\.6-apache/)
  assert.doesNotMatch(compose, /^  updatesFrom: \[4\]$/m)
  assert.match(compose, /^    image: mariadb:11\.8\.9-noble@sha256:d36f18d65a0459510b8b0f643b226a6d299e3206486e2b64ff20754a6d291707$/m)
})
