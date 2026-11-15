// idea#403: release check against the previous release tag (agent-app-dev check-compose --base-ref).
// A stateful image (MariaDB, MySQL, Postgres, Mongo, Redis) that moves to a new series needs an App major.
// script/check-base-ref.sh picks the highest release tag that is an ancestor of HEAD and not HEAD's own
// tag. A shallow clone or a clone with no release tags fails (CHECK_BASE_REF_FIRST_RELEASE=1 for a real
// first release); release tags with none an ancestor = first release, skipped with a note.
// Set AAD_CHECK_COMPOSE to agent-app-dev script/check-compose.mjs to run the compare.
// Run in a full clone with tags (CI: fetch-depth: 0); in a shallow or tagless clone the first test fails.
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(root, 'script', 'check-base-ref.sh')
const NO_TAGS = 'no release tags in this clone: git fetch --tags; for a real first release set CHECK_BASE_REF_FIRST_RELEASE=1'
const git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' })
const isGit = git('rev-parse', '--git-dir').status === 0
const envWithout = (k) => { const e = { ...process.env }; delete e[k]; return e }

it('this clone: the previous release tag is a release tag, an ancestor of HEAD, not HEAD\'s own', { skip: !isGit && 'not a git checkout' }, () => {
  const r = spawnSync(SCRIPT, ['--print-tag'], { encoding: 'utf8', env: process.env })
  assert.equal(r.status, 0, r.stderr) // a shallow or tagless clone fails here: fetch full history and tags
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

it('temp repo: tag choice, no-tags failure, first-release variable, shallow and --no-tags clones', () => {
  const d = mkdtempSync(join(tmpdir(), 'base-ref-'))
  const run = (cwd, ...a) => { const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr) }
  const g = (...a) => run(d, ...a)
  mkdirSync(join(d, 'script')); copyFileSync(SCRIPT, join(d, 'script', 'check-base-ref.sh'))
  const env = envWithout('CHECK_BASE_REF_FIRST_RELEASE')
  const at = (dir, extra = {}) => spawnSync(join(dir, 'script', 'check-base-ref.sh'), ['--print-tag'], { encoding: 'utf8', env: { ...env, ...extra } })
  const pick = () => { const r = at(d); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
  const noTags = (r) => { assert.equal(r.status, 1); assert.equal(r.stderr.trim(), NO_TAGS) }
  const commit = (m) => { writeFileSync(join(d, 'f'), m); g('add', '.'); g('commit', '-qm', m) }
  g('init', '-q', '-b', 'main'); commit('a')
  noTags(at(d))                                             // no tags at all: fail
  g('tag', 'zimbabwe-2026-10-20'); noTags(at(d))            // no *release* tags: fail
  let r = at(d, { CHECK_BASE_REF_FIRST_RELEASE: '1' })
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '') // real first release, set explicitly
  r = spawnSync(join(d, 'script', 'check-base-ref.sh'), [], { encoding: 'utf8', env: { ...env, CHECK_BASE_REF_FIRST_RELEASE: '1' } })
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /first release/)
  g('tag', '1.0'); assert.equal(pick(), '')                 // release tags, none an ancestor but HEAD's own: first release
  commit('b'); g('tag', '1.2-3.0'); g('tag', '1.0.1')
  commit('c'); g('tag', '1.10-3.0')                         // HEAD's own
  assert.equal(pick(), '1.2-3.0')                           // 1.2 > 1.0; date and three-number tags ignored
  g('checkout', '-qb', 'side', 'HEAD~2'); commit('s'); g('tag', '9.0'); g('checkout', '-q', 'main')
  assert.equal(pick(), '1.2-3.0')                           // 9.0 is not an ancestor
  commit('d'); assert.equal(pick(), '1.10-3.0')            // numeric minor order: 1.10 > 1.2
  const c = mkdtempSync(join(tmpdir(), 'base-ref-clone-'))
  const notags = join(c, 'notags'), shallow = join(c, 'shallow')
  run(c, 'clone', '-q', '--no-tags', `file://${d}`, notags)
  noTags(at(notags))                                        // full clone without tags must not pass
  run(c, 'clone', '-q', '--depth', '1', `file://${d}`, shallow)
  r = at(shallow); assert.equal(r.status, 1); assert.match(r.stderr, /shallow clone/)
})
