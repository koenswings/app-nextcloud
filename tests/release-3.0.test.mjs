/**
 * Release 3.0-33.0.11 is now history: this tree is 4.0-34.0.6.
 * Keep the 3.0 notes in docs/releases.md. Live compose / tarball pins live in
 * tests/release-4.0.test.mjs.
 * Run: node --test tests/
 */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

it('release notes still document 3.0-33.0.11 as the previous hop', () => {
  const notes = readFileSync(join(root, 'docs/releases.md'), 'utf8')
  assert.match(notes, /^## 3\.0-33\.0\.11$/m)
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
  assert.ok(existsSync(join(root, 'config/idea-skeleton.config.php')), 'skeleton config still ships')
})

it('live compose is no longer 3.0-33.0.11 (superseded by 4.0)', () => {
  const compose = readFileSync(join(root, 'compose.yaml'), 'utf8')
  assert.doesNotMatch(compose, /^  version: "3\.0-33\.0\.11"$/m)
  assert.doesNotMatch(compose, /nextcloud:33\.0\.11-apache/)
  assert.doesNotMatch(compose, /richdocuments-v10\.3\.3/)
  assert.doesNotMatch(compose, /^  updatesFrom: \[2\]$/m)
})
