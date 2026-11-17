/**
 * Release 2.0-32.0.15 is now history: this tree is 3.0-33.0.11.
 * Keep the 2.0 notes in docs/releases.md. Live compose / tarball pins live in
 * tests/release-3.0.test.mjs.
 * Run: node --test tests/
 */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

it('release notes still document 2.0-32.0.15 as the previous hop', () => {
  const notes = readFileSync(join(root, 'docs/releases.md'), 'utf8')
  assert.match(notes, /^## 2\.0-32\.0\.15$/m)
  assert.match(notes, /32\.0\.15-apache/, '2.0: Nextcloud 32 hop')
  assert.match(notes, /db18aaa3a58302d7363dc59905c310f6df5141800bc8f336ab9cdec5577c6211/, '2.0: upstream index digest')
  assert.match(notes, /richdocuments 9\.2\.3/)
  assert.match(notes, /x-app\.update\.prepare/)
  assert.match(notes, /x-app\.update\.verify/)
  assert.match(notes, /x-app\.update\.work/)
  assert.match(notes, /x-app\.update\.settle/)
  assert.match(notes, /\*\*Database:\*\* no database image upgrade in this release/, '2.0: DB change stated explicitly (none)')
  assert.match(notes, /Pi proof\s+pending \(pool\s+reserved/)
  assert.match(notes, /^## 1\.8-31\.0\.14$/m)
  assert.ok(existsSync(join(root, 'config/idea-skeleton.config.php')), 'skeleton config still ships')
})

it('live compose is no longer 2.0-32.0.15 (superseded by 3.0)', () => {
  const compose = readFileSync(join(root, 'compose.yaml'), 'utf8')
  assert.doesNotMatch(compose, /^  version: "2\.0-32\.0\.15"$/m)
  assert.doesNotMatch(compose, /nextcloud:32\.0\.15-apache/)
  assert.doesNotMatch(compose, /richdocuments-v9\.2\.3/)
  assert.doesNotMatch(compose, /^  updatesFrom: \[1\]$/m)
})
