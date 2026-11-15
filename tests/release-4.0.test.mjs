/**
 * Release 4.0-34.0.6 is now history: this tree is 5.0-35.0.3.
 * Keep the 4.0 notes in docs/releases.md. Live compose / tarball pins live in
 * tests/release-5.0.test.mjs.
 * Run: node --test tests/
 */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

it('release notes still document 4.0-34.0.6 as the previous hop', () => {
  const notes = readFileSync(join(root, 'docs/releases.md'), 'utf8')
  assert.match(notes, /^## 4\.0-34\.0\.6$/m)
  assert.match(notes, /34\.0\.6-apache/, '4.0: Nextcloud 34 hop')
  assert.match(notes, /3031e7f87baaceb863a755921ebf463bc26ea71855c07ad7858e2ae25a5a0ad7/, '4.0: upstream index digest')
  assert.match(notes, /richdocuments` 11\.1\.3/)
  assert.match(notes, /x-app\.update\.prepare/)
  assert.match(notes, /x-app\.update\.verify/)
  assert.match(notes, /x-app\.update\.work/)
  assert.match(notes, /x-app\.update\.settle/)
  assert.match(notes, /\*\*Database:\*\* no database image upgrade in this release/, '4.0: DB change stated explicitly (none)')
  assert.match(notes, /updatesFrom: \[3\]/)
  assert.ok(existsSync(join(root, 'config/idea-skeleton.config.php')), 'skeleton config still ships')
})

it('live compose is no longer 4.0-34.0.6 (superseded by 5.0)', () => {
  const compose = readFileSync(join(root, 'compose.yaml'), 'utf8')
  assert.doesNotMatch(compose, /^  version: "4\.0-34\.0\.6"$/m)
  assert.doesNotMatch(compose, /nextcloud:34\.0\.6-apache/)
  assert.doesNotMatch(compose, /richdocuments-v11\.1\.3/)
  assert.doesNotMatch(compose, /^  updatesFrom: \[3\]$/m)
})
