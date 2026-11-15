// idea#403: release check against the previous release tag (agent-app-dev check-compose --base-ref).
// A stateful image (MariaDB, MySQL, Postgres, Mongo, Redis) that moves to a new series needs an App major.
// script/check-base-ref.sh picks the highest release tag that is an ancestor of HEAD and not HEAD's own
// tag (none = first release: skipped with a note). Set AAD_CHECK_COMPOSE to agent-app-dev
// script/check-compose.mjs to run the compare. Needs tags and full history (CI: fetch-depth: 0).
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(root, 'script', 'check-base-ref.sh')
const git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' })
const isGit = git('rev-parse', '--git-dir').status === 0
const shallow = isGit && git('rev-parse', '--is-shallow-repository').stdout.trim() === 'true'

it('previous release tag: a release tag, an ancestor of HEAD, not pointing at HEAD', { skip: !isGit && 'not a git checkout' }, () => {
  const r = spawnSync(SCRIPT, ['--print-tag'], { encoding: 'utf8' })
  if (shallow) { assert.equal(r.status, 1); assert.match(r.stderr, /shallow clone/); return }
  assert.equal(r.status, 0, r.stderr)
  const tag = r.stdout.trim()
  if (!tag) return // first release
  assert.match(tag, /^[0-9]+\.[0-9]+(-[A-Za-z0-9._]+)?$/)
  assert.equal(git('merge-base', '--is-ancestor', tag, 'HEAD').status, 0)
  assert.ok(!git('tag', '--points-at', 'HEAD').stdout.split('\n').includes(tag))
})

it('agent-app-dev check-compose --base-ref <previous release tag> (when AAD_CHECK_COMPOSE is set)',
  { skip: !process.env.AAD_CHECK_COMPOSE || !existsSync(process.env.AAD_CHECK_COMPOSE) }, () => {
    const r = spawnSync(SCRIPT, [], { encoding: 'utf8', env: process.env })
    assert.equal(r.status, 0, r.stdout + r.stderr)
  })

it('tag choice on a temp repo: highest ancestor release tag, never HEAD\'s own, a side branch or a non-release tag', () => {
  const d = mkdtempSync(join(tmpdir(), 'base-ref-'))
  const g = (...a) => { const r = spawnSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr) }
  mkdirSync(join(d, 'script')); copyFileSync(SCRIPT, join(d, 'script', 'check-base-ref.sh'))
  const pick = () => spawnSync(join(d, 'script', 'check-base-ref.sh'), ['--print-tag'], { encoding: 'utf8' }).stdout.trim()
  const commit = (m) => { writeFileSync(join(d, 'f'), m); g('add', '.'); g('commit', '-qm', m) }
  g('init', '-q', '-b', 'main'); commit('a')
  assert.equal(pick(), '')                                  // no tags: first release
  g('tag', '1.0'); assert.equal(pick(), '')                 // only HEAD's own tag
  commit('b'); g('tag', '1.2-3.0'); g('tag', 'zimbabwe-2026-10-20'); g('tag', '1.0.1')
  commit('c'); g('tag', '1.10-3.0')                         // HEAD's own
  assert.equal(pick(), '1.2-3.0')                           // 1.2 > 1.0; date and three-number tags ignored
  g('checkout', '-qb', 'side', 'HEAD~2'); commit('s'); g('tag', '9.0'); g('checkout', '-q', 'main')
  assert.equal(pick(), '1.2-3.0')                           // 9.0 is not an ancestor
  commit('d'); assert.equal(pick(), '1.10-3.0')            // numeric minor order: 1.10 > 1.2
})
