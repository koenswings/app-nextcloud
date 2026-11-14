// Nextcloud demo pack v1 (engine-dev#369): builder, pack.json shape, deterministic tar,
// app.yaml pin, CREDITS completeness and Engine path rules. Run: node --test tests/
import { it, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync, statSync, cpSync, renameSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, execSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILDER = join(root, 'demo/build-demo-pack.py')
const CONTENT = join(root, 'demo/content')
const CREDITS = join(root, 'demo/CREDITS.txt')
const RUNDIR = join(root, '.test-run')
mkdirSync(RUNDIR, { recursive: true })
const workdir = (p) => mkdtempSync(join(RUNDIR, p))
const read = (p) => readFileSync(p, 'utf8')
const sha256 = (b) => createHash('sha256').update(b).digest('hex')
// agent-engine-dev src/data/DemoPack.ts SAFE_REL
const SAFE_REL = /^(?![./])(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._][A-Za-z0-9._/\- ]*$/
const IDEA_CC_BY = '© IDEA (Initiative for Digital Education in Africa)'

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p, base) : [relative(base, p)] }).sort()
}
function build(out, args = []) {
  const r = spawnSync('python3', [BUILDER, '--out', out, ...args], { encoding: 'utf8' })
  return { ...r, meta: r.status === 0 ? JSON.parse(read(join(out, 'build-meta.json'))) : null }
}
function appYamlDemo() {
  const t = read(join(root, 'app.yaml'))
  const block = t.slice(t.indexOf('\ndemo:\n'))
  const get = (k) => (block.match(new RegExp(`^\\s+${k}:\\s*"?([^"\\n]*)"?\\s*$`, 'm')) || [])[1]
  return { block, name: get('name'), minEngine: get('minEngine'), file: get('file'), url: get('url'), sha256: get('sha256'), bytes: Number(get('bytes')), minVersion: Number(get('minVersion')), reserveBytes: Number(get('reserveBytes')) }
}
function copyContent(dir) {
  const c = join(dir, 'content'); cpSync(CONTENT, c, { recursive: true })
  const cr = join(dir, 'CREDITS.txt'); writeFileSync(cr, read(CREDITS))
  return { c, cr }
}

describe('build-demo-pack.py', () => {
  it('writes pack.json (schemaVersion 1, app nextcloud, hook seed/running) with matching hashes', () => {
    const out = join(workdir('ncbuild-'), 'out')
    const { status, stderr, meta } = build(out)
    assert.equal(status, 0, stderr)
    const pack = JSON.parse(read(join(out, 'pack.json')))
    assert.equal(pack.schemaVersion, 1)
    assert.equal(pack.packVersion, 1)
    assert.equal(pack.app, 'nextcloud')
    assert.equal(pack.minAppVersion, '1.5-31.0.1')
    assert.equal(pack.credits, 'CREDITS.txt')
    assert.deepEqual(pack.hooks, [{ id: 'seed', needs: 'running' }])
    assert.equal(pack.files.some(f => f.path === 'pack.json'), false)
    assert.ok(pack.files.find(f => f.path === 'CREDITS.txt' && f.bytes > 0))
    assert.deepEqual(pack.files.map(f => f.path).sort(), ['CREDITS.txt', ...walk(CONTENT)].sort())
    assert.equal(pack.bytes, pack.files.reduce((n, f) => n + f.bytes, 0))
    for (const f of pack.files) {
      const body = readFileSync(join(out, 'root', f.path))
      assert.equal(body.length, f.bytes); assert.equal(sha256(body), f.sha256)
      assert.match(f.path, SAFE_REL, `${f.path} breaks the Engine SAFE_REL rule`)
    }
    const tar = join(out, 'idea-demo-nextcloud-v1.tar')
    assert.equal(meta.sha256, sha256(readFileSync(tar)))
    assert.equal(meta.sha256, read(join(out, 'SHA256SUMS')).split(/\s+/)[0])
    const list = execSync(`tar -tf '${tar}'`, { encoding: 'utf8' }).trim().split('\n')
    assert.deepEqual(list.slice(0, 2), ['pack.json', 'CREDITS.txt'])
    const tops = new Set(list.map(n => n.split('/')[0]))
    assert.deepEqual([...tops].sort(), ['CREDITS.txt', 'Class', 'Learner Files', 'Teacher Notes', 'Worksheets', 'pack.json'])
    for (const n of list) assert.equal(n.startsWith('/') || n.split('/').includes('..'), false)
    const verbose = execSync(`tar -tvf '${tar}'`, { encoding: 'utf8' })
    assert.equal(/ 0\/0 /.test(verbose.split('\n')[0]), true, 'owner 0/0')
  })

  it('is deterministic: two builds give the same tar sha256', () => {
    const d = workdir('ncdet-')
    assert.equal(build(join(d, 'a')).meta.sha256, build(join(d, 'b')).meta.sha256)
  })

  it('refuses a file name the Engine would refuse (brackets)', () => {
    const d = workdir('ncsafe-'); const { c, cr } = copyContent(d)
    renameSync(join(c, 'Worksheets/Fractions practice.md'), join(c, 'Worksheets/Fractions (practice).md'))
    writeFileSync(cr, read(cr).replace('Worksheets/Fractions practice.md |', 'Worksheets/Fractions (practice).md |'))
    const r = build(join(d, 'out'), ['--content', c, '--credits', cr])
    assert.notEqual(r.status, 0); assert.match(r.stderr, /SAFE_REL/)
  })
})

describe('CREDITS.txt completeness', () => {
  it('has one catalogue line with a licence name and URL for every pack file, and no extra lines', () => {
    const text = read(CREDITS)
    const cat = text.split('\nCatalogue\n')[1].split('\nStandard attribution sentences')[0].split('\n').filter(l => l.includes(' | '))
    const paths = cat.map(l => l.split(' | ')[0])
    assert.deepEqual([...paths].sort(), walk(CONTENT))
    for (const l of cat) {
      const [p, title, author, url, ...lic] = l.split(' | ')
      assert.ok(title && author && /^https:\/\//.test(url), `incomplete line for ${p}`)
      assert.match(lic.join(' | '), /(Creative Commons|Public Domain).*https:\/\/creativecommons\.org\//, `no licence for ${p}`)
    }
  })
  it('credits every IDEA-written file as CC BY 4.0 © IDEA, and each such file says so', () => {
    const text = read(CREDITS)
    for (const p of walk(CONTENT).filter(p => p.endsWith('.md'))) {
      const line = text.split('\n').find(l => l.startsWith(`${p} | `))
      assert.ok(line.includes(IDEA_CC_BY) && line.includes('CC BY 4.0') && line.includes('https://creativecommons.org/licenses/by/4.0/'), p)
      assert.match(read(join(CONTENT, p)), /© IDEA \(Initiative for Digital Education in Africa\)\. CC BY 4\.0\./, `${p} footer`)
    }
    assert.match(text, /"Use CC BY 4\.0 for IDEA's own demo content\."/)
  })
  it('third-party files are credited with author, source and their own licence', () => {
    const text = read(CREDITS)
    assert.match(text, /^Worksheets\/Blank fraction circles\.png \| FractionCircles Blank \| Zapotz \| https:\/\/commons\.wikimedia\.org\/wiki\/File:FractionCircles_Blank\.PNG \| .*CC0 1\.0/m)
    assert.match(text, /^Worksheets\/How Tortoise got a crooked nose - colour-in\.pdf \| .*African Storybook Initiative 2015 \| https:\/\/www\.africanstorybook\.org\/.* \| .*CC BY 4\.0/m)
  })
  it('the builder refuses a missing catalogue line, an extra line and an empty CREDITS', () => {
    const d = workdir('nccred-')
    let { c, cr } = copyContent(join(d, '1') && (mkdirSync(join(d, '1')), join(d, '1')))
    writeFileSync(join(c, 'Worksheets/Extra sheet.md'), 'x\n')
    let r = build(join(d, '1', 'out'), ['--content', c, '--credits', cr])
    assert.notEqual(r.status, 0); assert.match(r.stderr, /no catalogue line for: \['Worksheets\/Extra sheet\.md'\]/)
    mkdirSync(join(d, '2')); ({ c, cr } = copyContent(join(d, '2')))
    writeFileSync(cr, read(cr).replace('\nStandard attribution sentences', 'Worksheets/Gone.md | Gone | IDEA | https://example.org | Creative Commons Attribution 4.0 International (CC BY 4.0); https://creativecommons.org/licenses/by/4.0/\n\nStandard attribution sentences'))
    r = build(join(d, '2', 'out'), ['--content', c, '--credits', cr])
    assert.notEqual(r.status, 0); assert.match(r.stderr, /not in the pack: \['Worksheets\/Gone\.md'\]/)
    mkdirSync(join(d, '3')); ({ c, cr } = copyContent(join(d, '3')))
    writeFileSync(cr, '')
    r = build(join(d, '3', 'out'), ['--content', c, '--credits', cr])
    assert.notEqual(r.status, 0); assert.match(r.stderr, /credits missing or empty/)
  })
})

describe('committed pin (app.yaml demo block, demo/pack.json)', () => {
  it('app.yaml pins the sha256 and bytes of a fresh build, with the planned release url', () => {
    const out = join(workdir('ncpin-'), 'out')
    const { meta } = build(out)
    const d = appYamlDemo()
    assert.equal(d.name, 'Nextcloud Demo')
    assert.equal(d.minEngine, '1.0')
    assert.equal(d.file, 'idea-demo-nextcloud-v1.tar')
    assert.equal(d.url, 'https://github.com/koenswings/app-nextcloud/releases/download/idea-demo-nextcloud-v1/idea-demo-nextcloud-v1.tar')
    assert.equal(d.sha256, meta.sha256, 'app.yaml sha256 is stale: run demo/build-demo-pack.py --out <dir> --repo-pack demo --pin app.yaml')
    assert.equal(d.bytes, meta.bytes)
    assert.equal(d.minVersion, 1)
    assert.ok(d.reserveBytes > 0)
    assert.equal(read(join(root, 'demo/pack.json')), read(join(out, 'pack.json')), 'demo/pack.json is stale')
  })
  it('app.yaml steps match the pack hooks: one seed step, needs running, run demo/hook.sh seed', () => {
    const steps = appYamlDemo().block.split('\n').filter(l => /^\s+- \{ id:/.test(l))
    assert.equal(steps.length, 1)
    assert.match(steps[0], /id: seed, run: demo\/hook\.sh seed, needs: running, timeoutSec: \d+/)
    const pack = JSON.parse(read(join(root, 'demo/pack.json')))
    assert.deepEqual(pack.hooks, [{ id: 'seed', needs: 'running' }])
  })
  it('the bundle ships no demo-pack/ folder', () => {
    assert.equal(readdirSync(root).includes('demo-pack'), false)
    assert.equal(readdirSync(join(root, 'demo')).includes('demo-pack'), false)
  })
})
