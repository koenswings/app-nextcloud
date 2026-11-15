/**
 * Release 1.8-31.0.14 is now history: this tree is 6.0-35.0.3.
 * Keep the 1.8 notes in docs/releases.md. Live compose / tarball pins live in
 * tests/release-6.0.test.mjs.
 * Run: node --test tests/
 */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

it('release notes still document 1.8-31.0.14 (and 1.7, 1.6, 1.5) as history', () => {
  const notes = readFileSync(join(root, 'docs/releases.md'), 'utf8')
  assert.match(notes, /^## 1\.8-31\.0\.14$/m)
  assert.match(notes, /31\.0\.14-apache/, '1.8: Nextcloud point update')
  assert.match(notes, /07ec73cc816e58d6f45a162cd53ef886462c29271a23fc68d0124cec276e3767/, '1.8: upstream index digest')
  assert.match(notes, /Pi proof on idea04/, '1.8: Pi proof recorded (#41)')
  assert.match(notes, /4b9b6c17-bde0-4394-bdd6-f86e713a8fde/, '1.8: updateApp trace')
  assert.match(notes, /1\.7-31\.0\.1` \(1c8247b\)/, '1.7 tag recorded')
  assert.match(notes, /1\.8-31\.0\.14` \(6a48eca\)/, '1.8 tag recorded')
  assert.match(notes, /koenswings\/nextcloud:1\.8-31\.0\.14` is not published yet \(needs Koen YES\)/, '1.8: retag still unpublished')
  assert.match(notes, /richdocuments` stays 8\.8\.3/)
  assert.match(notes, /^## 1\.7-31\.0\.1$/m)
  assert.match(notes, /app-nextcloud#29/, '1.7: healthcheck during backup maintenance')
  assert.match(notes, /^## 1\.6-31\.0\.1$/m)
  assert.match(notes, /x-app\.backup/, '1.6: live backup hook')
  assert.match(notes, /^## 1\.5-31\.0\.1$/m)
  assert.match(notes, /before `maintenance:install`/, '#23: skeleton config in place before install')
  assert.ok(existsSync(join(root, 'config/idea-skeleton.config.php')), '#23 config file ships in the release')
})

it('live compose is no longer 1.8-31.0.14 (superseded by 6.0)', () => {
  const compose = readFileSync(join(root, 'compose.yaml'), 'utf8')
  assert.doesNotMatch(compose, /^  version: "1\.8-31\.0\.14"$/m)
  assert.doesNotMatch(compose, /nextcloud:31\.0\.14-apache/)
  assert.doesNotMatch(compose, /richdocuments-v8\.8\.3/)
})
