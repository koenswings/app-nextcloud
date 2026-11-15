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

it('live compose is no longer 5.0-34.0.6 (superseded by 6.0); MariaDB 11.8.9 is kept', () => {
  const compose = readFileSync(join(root, 'compose.yaml'), 'utf8')
  assert.doesNotMatch(compose, /^  version: "5\.0-34\.0\.6"$/m)
  assert.doesNotMatch(compose, /nextcloud:34\.0\.6-apache/)
  assert.doesNotMatch(compose, /^  updatesFrom: \[4\]$/m)
  assert.match(compose, /^    image: mariadb:11\.8\.9-noble@sha256:d36f18d65a0459510b8b0f643b226a6d299e3206486e2b64ff20754a6d291707$/m)
})
