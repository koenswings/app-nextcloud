/**
 * Unit tests for idea_version_ge in hooks/update-lib.sh (verify's "pinned
 * richdocuments version or newer" rule, Steve's decision 2026-11-16).
 * Runs under the default awk and, when present, mawk (the awk in the Debian-based
 * official Nextcloud image) and gawk.
 * Run: node --test tests/*.test.mjs
 */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(root, 'hooks/update-lib.sh')

const which = (cmd) => {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}
const awks = [['awk', null]]
for (const a of ['mawk', 'gawk']) { const p = which(a); if (p) awks.push([a, p]) }

const ge = (have, want, awkPath) => {
  let env = { PATH: process.env.PATH }
  let tmp = null
  if (awkPath) {
    tmp = mkdtempSync(join(tmpdir(), 'idea-awk-'))
    mkdirSync(join(tmp, 'bin'))
    symlinkSync(awkPath, join(tmp, 'bin', 'awk'))
    env = { PATH: `${join(tmp, 'bin')}:${process.env.PATH}` }
  }
  const r = spawnSync('sh', ['-c', '. "$0"; idea_version_ge "$1" "$2"', LIB, have, want], { encoding: 'utf8', env })
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  return r.status
}

// [have, want, expected exit]  0: have >= want, 1: have < want, 2: not a version
const CASES = [
  ['9.2.3', '9.2.3', 0],
  ['9.2.4', '9.2.3', 0],
  ['9.3.0', '9.2.3', 0],
  ['10.0.0', '9.2.3', 0],
  ['9.10.0', '9.2.3', 0], // string compare would say "9.10.0" < "9.2.3"
  ['9.2.10', '9.2.3', 0], // string compare would say "9.2.10" < "9.2.3"
  ['10.3.3', '9.99.99', 0],
  ['9.2.2', '9.2.3', 1],
  ['9.1.10', '9.2.3', 1],
  ['8.99.99', '9.2.3', 1],
  ['9.2', '9.2.0', 0],
  ['9.2.0', '9.2', 0],
  ['9.2', '9.2.1', 1],
  ['9.2.3.1', '9.2.3', 0],
  ['v9.2.3', '9.2.3', 0],
  ['9.2.3+build.7', '9.2.3', 0],
  ['9.2.3', '9.2.3-beta.1', 0], // release beats pre-release
  ['9.2.3-beta.1', '9.2.3', 1],
  ['9.2.3-beta.10', '9.2.3-beta.2', 0], // numeric identifiers compare numerically
  ['9.2.3-beta.2', '9.2.3-beta.10', 1],
  ['9.2.3-rc.1', '9.2.3-beta.10', 0], // ASCII order for alphanumerics
  ['9.2.3-beta', '9.2.3-beta.1', 1], // shorter identifier list first
  ['9.2.3-1', '9.2.3-alpha', 1], // numeric < alphanumeric
  ['master', '9.2.3', 2],
  ['9..2', '9.2.3', 2],
  ['', '9.2.3', 2],
  ['9.2.3-', '9.2.3', 2],
  ['9.2.3', 'x', 2],
]

for (const [name, path] of awks) {
  it(`idea_version_ge semver cases (${name})`, () => {
    for (const [have, want, exp] of CASES) {
      assert.equal(ge(have, want, path), exp, `${name}: idea_version_ge ${have} ${want}`)
    }
  })
}

it('verify-update.sh uses idea_version_ge for richdocuments, not a fixed-string grep', () => {
  const src = spawnSync('cat', [join(root, 'hooks/verify-update.sh')], { encoding: 'utf8' }).stdout
  const body = src.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
  assert.match(body, /idea_version_ge "\$rd_have" "\$IDEA_RD_VER"/)
  assert.doesNotMatch(body, /richdocuments: \$\{IDEA_RD_VER\}\$/)
})
