// demo/hook.sh + demo/seed_nextcloud.py (engine-dev#369 'seed', needs: running).
// A fake Nextcloud (status.php, WebDAV, OCS shares; Basic auth against the fake occ
// passwords) and a fake docker/occ. Checks the hook contract, the school passwords,
// files and shares, and idempotence. Run: node --test tests/
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync, execSync } from 'node:child_process'
import { createServer } from 'node:http'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = join(root, 'demo/hook.sh')
const SEED = join(root, 'demo/seed_nextcloud.py')
const BUILDER = join(root, 'demo/build-demo-pack.py')
const DOCKER = join(root, 'tests/fake-docker-seed.sh')
const RUNDIR = join(root, '.test-run')   // not /tmp: the hook refuses a pack dir under /tmp
mkdirSync(RUNDIR, { recursive: true })
const workdir = (p) => mkdtempSync(join(RUNDIR, p))
const read = (p) => readFileSync(p, 'utf8')
const code = (p) => read(p).split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
const pyCode = (p) => code(p).replace(/^"""[\s\S]*?"""/m, '')

const DEMO = {
  teacher1: ['teachers'], teacher2: ['teachers'],
  learner1: ['learners', 'grade5a'], learner2: ['learners', 'grade5a'], learner3: ['learners', 'grade5a'],
}

// ── fake Nextcloud ───────────────────────────────────────────────────────────
function fakeNextcloud(occFile) {
  const st = { files: new Map(), dirs: new Set(), shares: [], nextId: 1, log: [] }
  const auth = (req) => {
    const h = req.headers.authorization || ''
    const [u, p] = Buffer.from(h.replace(/^Basic /, ''), 'base64').toString().split(/:(.*)/s)
    const users = JSON.parse(read(occFile)).users
    return users[u] && users[u].pass === p ? u : null
  }
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c)).on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(req.url, 'http://x')
      if (url.pathname === '/status.php') { res.end(JSON.stringify({ installed: true, maintenance: false, needsDbUpgrade: false })); return }
      const user = auth(req)
      if (!user) { res.statusCode = 401; res.end(); return }
      if (req.method !== 'GET' && req.method !== 'PROPFIND') st.log.push(`${user} ${req.method} ${decodeURIComponent(url.pathname)}`)
      const dav = url.pathname.match(/^\/remote\.php\/dav\/files\/([^/]+)\/(.*)$/)
      if (dav) {
        const owner = decodeURIComponent(dav[1]); if (owner !== user) { res.statusCode = 403; res.end(); return }
        const rel = decodeURIComponent(dav[2]).replace(/\/$/, ''); const key = `${owner}:/${rel}`
        const parentOk = !rel.includes('/') || st.dirs.has(`${owner}:/${rel.slice(0, rel.lastIndexOf('/'))}`)
        switch (req.method) {
          case 'PROPFIND': res.statusCode = (st.dirs.has(key) || st.files.has(key)) ? 207 : 404; res.end('<d:multistatus xmlns:d="DAV:"/>'); return
          case 'MKCOL': if (st.dirs.has(key)) { res.statusCode = 405 } else if (!parentOk) { res.statusCode = 409 } else { st.dirs.add(key); res.statusCode = 201 } res.end(); return
          case 'GET': if (st.files.has(key)) { res.end(st.files.get(key)) } else { res.statusCode = 404; res.end() } return
          case 'PUT': if (!parentOk) { res.statusCode = 409; res.end(); return } res.statusCode = st.files.has(key) ? 204 : 201; st.files.set(key, body); res.end(); return
        }
      }
      if (url.pathname.startsWith('/ocs/v2.php/apps/files_sharing/api/v1/shares')) {
        const ok = (data) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ocs: { meta: { status: 'ok', statuscode: 200, message: 'OK' }, data } })) }
        if (req.headers['ocs-apirequest'] !== 'true') { res.statusCode = 400; res.end('{}'); return }
        const id = url.pathname.split('/').pop()
        if (req.method === 'GET') { const p = url.searchParams.get('path'); ok(st.shares.filter(s => s.uid_owner === user && s.path === p)); return }
        const f = new URLSearchParams(body.toString())
        if (req.method === 'POST') {
          const groups = JSON.parse(read(occFile)).groups
          if (!st.dirs.has(`${user}:${f.get('path')}`) || !groups[f.get('shareWith')] || f.get('shareType') !== '1') { res.statusCode = 404; res.end(JSON.stringify({ ocs: { meta: { statuscode: 404, message: 'bad share' }, data: [] } })); return }
          const s = { id: String(st.nextId++), share_type: 1, uid_owner: user, path: f.get('path'), share_with: f.get('shareWith'), permissions: Number(f.get('permissions')) }
          st.shares.push(s); ok(s); return
        }
        if (req.method === 'PUT') { const s = st.shares.find(x => x.id === id && x.uid_owner === user); s.permissions = Number(f.get('permissions')); ok(s); return }
      }
      res.statusCode = 404; res.end()
    })
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, st, port: server.address().port })))
}

function run(cmd, args, env) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { env })
    let stdout = '', stderr = ''
    p.stdout.on('data', d => stdout += d); p.stderr.on('data', d => stderr += d)
    p.on('close', status => resolve({ status, stdout, stderr }))
  })
}

function buildPack(dir) {
  const out = join(dir, 'build')
  const r = spawnSync('python3', [BUILDER, '--out', out], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  return out
}

function setup({ installed = true } = {}) {
  const dir = workdir('nchook-')
  const inst = join(dir, 'instances', 'nc-demo')
  mkdirSync(join(inst, 'data', 'nextcloud'), { recursive: true })
  const pack = join(inst, 'demo-pack', 'x')
  const out = buildPack(dir)
  mkdirSync(pack, { recursive: true })
  execSync(`tar -xf ${join(out, 'idea-demo-nextcloud-v1.tar')} -C ${pack}`)
  const occ = join(dir, 'occ.json')
  // as after first start: admin from the install, teacher1/learner1 from 20-idea-accounts.sh
  writeFileSync(occ, JSON.stringify({ installed, groups: { admin: {}, teachers: {}, learners: {} }, users: {
    admin: { display: 'admin', pass: 'admin911!', groups: ['admin'] },
    teacher1: { display: 'teacher1', pass: 'teacher1911!', groups: ['teachers'] },
    learner1: { display: 'learner1', pass: 'learner1911!', groups: ['learners'] },
  }, log: [] }))
  const dlog = join(dir, 'docker.log')
  return { dir, inst, pack, out, occ, dlog }
}

const hookEnv = (t, port, extra = {}) => ({
  PATH: process.env.PATH,
  IDEA_DEMO: '1',
  IDEA_DEMO_INSTANCE_ID: 'nc-demo',
  IDEA_DEMO_INSTANCE_DIR: t.inst,
  IDEA_DEMO_DATA_DIR: join(t.inst, 'data'),
  IDEA_DEMO_PACK_DIR: t.pack,
  IDEA_DEMO_PORT: String(port),
  IDEA_DEMO_COMPOSE_PROJECT: 'nc-demo',
  DOCKER: DOCKER,
  FAKE_PROJECT: 'nc-demo',
  FAKE_DOCKER_LOG: t.dlog,
  FAKE_OCC: t.occ,
  IDEA_DEMO_READY_STEP: '0.05',
  ...extra,
})
const summary = (r) => JSON.parse(r.stdout.trim().split('\n').pop())

describe('hook.sh / seed_nextcloud.py static contract', () => {
  it('never drives the Engine or the compose lifecycle', () => {
    for (const f of [HOOK, SEED]) {
      const t = f.endsWith('.py') ? pyCode(f) : code(f)
      for (const s of ['engine-cmd', 'installApp', 'startInstance', 'stopInstance', 'docker compose', '"compose"', 'compose up', 'compose down', 'commands.push']) {
        assert.equal(t.includes(s), false, `${f} must not use ${s}`)
      }
    }
  })
  it('uses no /tmp, mktemp or tempfile', () => {
    const hook = code(HOOK).replace(/case "\$resolved" in[\s\S]*?esac/, '')
    assert.equal(/mktemp|\/tmp/.test(hook), false, 'hook.sh must not use /tmp or mktemp (outside the refusal)')
    assert.match(read(HOOK), /must not be under \/tmp/)
    const py = pyCode(SEED)
    assert.equal(/tempfile|mkdtemp|\/tmp|open\([^)]*['"]w/.test(py), false, 'seed_nextcloud.py must not write files')
  })
  it('occ runs only via docker exec into the nextcloud-app container of IDEA_DEMO_COMPOSE_PROJECT', () => {
    const py = pyCode(SEED)
    assert.match(py, /label=com\.docker\.compose\.project=\{self\.project\}/)
    assert.match(py, /label=com\.docker\.compose\.service=nextcloud-app/)
    assert.match(py, /"exec", "-u", "33"/)
    assert.match(py, /IDEA_DEMO_COMPOSE_PROJECT/)
  })
  it('the only hook step is seed (bundle demo/hook.sh), matching pack.json', () => {
    const r = spawnSync('bash', [HOOK, 'classwork'], { encoding: 'utf8' })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /unknown step/)
  })
})

describe('hook.sh pack dir', () => {
  it('refuses IDEA_DEMO_PACK_DIR under /tmp', () => {
    const r = spawnSync('bash', [HOOK, 'seed'], { encoding: 'utf8', env: { PATH: process.env.PATH, IDEA_DEMO_PACK_DIR: '/tmp/ncdemo-pack-test', IDEA_DEMO_PORT: '1' } })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /must not be under \/tmp/)
  })
  it('extracts the tar beside x/ into IDEA_DEMO_PACK_DIR (creating it) when x/ is empty', () => {
    const t = setup()
    const inst2 = join(t.dir, 'instances', 'nc-demo-2')
    mkdirSync(join(inst2, 'demo-pack'), { recursive: true })
    execSync(`cp ${join(t.out, 'idea-demo-nextcloud-v1.tar')} ${join(inst2, 'demo-pack')}/`)
    const pack2 = join(inst2, 'demo-pack', 'x')
    const r = spawnSync('bash', [HOOK, 'seed'], { encoding: 'utf8', env: { PATH: process.env.PATH, DRY: '1', IDEA_DEMO_INSTANCE_DIR: inst2, IDEA_DEMO_PACK_DIR: pack2, IDEA_DEMO_PORT: '1' } })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(existsSync(join(pack2, 'pack.json')), true)
    assert.equal(existsSync(join(pack2, 'Worksheets', 'Fractions practice.md')), true)
  })
  it('refuses a tar with an unsafe member', () => {
    const t = setup()
    const inst2 = join(t.dir, 'instances', 'nc-bad')
    mkdirSync(join(inst2, 'demo-pack'), { recursive: true })
    // GNU tar strips '../' when creating, so write the member name with Python's tarfile.
    const evil = join(inst2, 'demo-pack', 'idea-demo-nextcloud-v1.tar')
    execSync(`python3 -c 'import io,sys,tarfile; t=tarfile.open(sys.argv[1],"w"); i=tarfile.TarInfo("../x.txt"); i.size=1; t.addfile(i, io.BytesIO(b"x")); t.close()' ${evil}`)
    const r = spawnSync('bash', [HOOK, 'seed'], { encoding: 'utf8', env: { PATH: process.env.PATH, DRY: '1', IDEA_DEMO_INSTANCE_DIR: inst2, IDEA_DEMO_PACK_DIR: join(inst2, 'demo-pack', 'x'), IDEA_DEMO_PORT: '1' } })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /unsafe tar member/)
  })
})

describe('hook.sh seed against a fake Nextcloud', () => {
  let nc, t
  before(async () => { t = setup(); nc = await fakeNextcloud(t.occ) })
  after(() => nc.server.close())

  it('first run: groups, users with <account>911!, files and shares', async () => {
    const r = await run('bash', [HOOK, 'seed'], hookEnv(t, nc.port))
    assert.equal(r.status, 0, r.stderr + r.stdout)
    const s = summary(r)
    assert.equal(s.result, 'seeded')
    const occ = JSON.parse(read(t.occ))
    assert.deepEqual(Object.keys(occ.groups).sort(), ['admin', 'grade5a', 'learners', 'teachers'])
    assert.equal(occ.groups.grade5a.display, 'Grade 5A')
    for (const [u, groups] of Object.entries(DEMO)) {
      assert.ok(occ.users[u], `${u} missing`)
      assert.equal(occ.users[u].pass, `${u}911!`)
      assert.deepEqual([...occ.users[u].groups].sort(), [...groups].sort())
    }
    assert.equal(occ.users.admin.pass, 'admin911!')
    assert.equal(occ.users.teacher1.display, 'Teacher 1')
    assert.deepEqual(s.usersCreated.sort(), ['learner2', 'learner3', 'teacher2'])
    // files
    const f = (k) => nc.st.files.get(k)?.toString()
    assert.equal(f('teacher1:/Grade 5A/Welcome to Grade 5A.md'), read(join(root, 'demo/content/Class/Welcome to Grade 5A.md')))
    assert.ok(nc.st.files.has('teacher1:/Grade 5A/Worksheets/How Tortoise got a crooked nose - colour-in.pdf'))
    assert.ok(nc.st.files.has('teacher1:/Grade 5A/Worksheets/Blank fraction circles.png'))
    assert.ok(nc.st.files.has('teacher1:/Teacher Notes/About this demo.md'))
    for (const l of ['learner1', 'learner2', 'learner3']) assert.ok(nc.st.files.has(`${l}:/My work/My reading log.md`))
    const content = (d) => readdirSync(join(root, 'demo/content', d)).length
    assert.equal(nc.st.files.size, content('Class') + content('Worksheets') + content('Teacher Notes') + 3 * content('Learner Files'))
    // shares
    const sh = nc.st.shares.map(x => `${x.uid_owner}:${x.path}->${x.share_with}:${x.permissions}`).sort()
    assert.deepEqual(sh, ['teacher1:/Grade 5A->grade5a:1', 'teacher1:/Grade 5A->teachers:15', 'teacher1:/Teacher Notes->teachers:15'])
    // no password on any docker command line; OC_PASS passed by name only
    const docker = read(t.dlog)
    assert.equal(/911!/.test(docker), false, 'a password reached the docker argv')
    assert.match(docker, /exec -u 33 -e OC_PASS c0ffee123456 php occ user:add --password-from-env/)
    assert.match(docker, /ps -q --filter label=com\.docker\.compose\.project=nc-demo --filter label=com\.docker\.compose\.service=nextcloud-app/)
    assert.equal(/compose (up|down|start|stop)/.test(docker), false)
  })

  it('second run is a no-op: no new users, groups, folders, uploads or shares', async () => {
    const occBefore = JSON.parse(read(t.occ)).log.length
    const httpBefore = nc.st.log.length
    const r = await run('bash', [HOOK, 'seed'], hookEnv(t, nc.port))
    assert.equal(r.status, 0, r.stderr + r.stdout)
    const s = summary(r)
    for (const k of ['groupsCreated', 'usersCreated', 'passwordsReset', 'membershipsAdded', 'foldersCreated', 'filesUploaded', 'filesRestored', 'sharesCreated', 'sharesUpdated', 'usersSkipped']) {
      assert.deepEqual(s[k], [], `${k} should be empty on a re-run`)
    }
    assert.equal(s.filesUnchanged, nc.st.files.size)
    const newOcc = JSON.parse(read(t.occ)).log.slice(occBefore)
    assert.deepEqual(newOcc.filter(l => !/^(group:list|user:list)/.test(l)), [], 'only read-only occ calls on a re-run')
    assert.deepEqual(nc.st.log.slice(httpBefore), [], 'no write requests on a re-run')
    assert.equal(nc.st.shares.length, 3)
  })

  it('a changed demo file is put back in place; extra files and changed passwords are kept', async () => {
    nc.st.files.set('teacher1:/Grade 5A/Worksheets/Fractions practice.md', Buffer.from('scribbles'))
    nc.st.files.set('learner2:/My work/my story.md', Buffer.from('mine'))
    const occ = JSON.parse(read(t.occ)); occ.users.learner3.pass = 'changed-by-teacher'; writeFileSync(t.occ, JSON.stringify(occ))
    nc.st.shares[0].permissions = 31
    const before = nc.st.files.size
    // learner3 no longer accepts 911!: skipped with a warning, its password kept, exit 0
    const r = await run('bash', [HOOK, 'seed'], hookEnv(t, nc.port))
    assert.equal(r.status, 0, r.stderr + r.stdout)
    assert.deepEqual(summary(r).usersSkipped, ['learner3'])
    assert.match(r.stderr, /WARNING learner3 does not accept the demo password/)
    assert.equal(JSON.parse(read(t.occ)).users.learner3.pass, 'changed-by-teacher')
    assert.deepEqual(summary(r).sharesUpdated, ['teacher1:/Grade 5A->grade5a'])
    // the operator can ask for a reset to <account>911!
    const r2 = await run('bash', [HOOK, 'seed'], hookEnv(t, nc.port, { IDEA_DEMO_RESET_PASSWORDS: '1' }))
    assert.equal(r2.status, 0, r2.stderr + r2.stdout)
    const s = summary(r2)
    assert.equal(nc.st.files.get('teacher1:/Grade 5A/Worksheets/Fractions practice.md').toString(), read(join(root, 'demo/content/Worksheets/Fractions practice.md')))
    assert.equal(nc.st.files.get('learner2:/My work/my story.md').toString(), 'mine')
    assert.equal(nc.st.files.size, before)
    assert.equal(JSON.parse(read(t.occ)).users.learner3.pass, 'learner3911!')
    assert.deepEqual(s.usersSkipped, [])
    assert.deepEqual(s.sharesUpdated, [])
    assert.equal(nc.st.shares.length, 3)
  })

  it('writes nothing in the bundle (no __pycache__) and nothing outside the pack it was given', () => {
    assert.equal(existsSync(join(root, 'demo', '__pycache__')), false)
    assert.deepEqual(readdirSync(join(t.inst, 'demo-pack')), ['x'])
  })
})

describe('hook.sh seed failures', () => {
  it('times out with 14 when Nextcloud never finishes installing', async () => {
    const t = setup({ installed: false }); const nc = await fakeNextcloud(t.occ)
    try {
      const r = await run('bash', [HOOK, 'seed'], hookEnv(t, nc.port, { IDEA_DEMO_READY_WAIT: '0' }))
      assert.equal(r.status, 14, r.stderr)
      assert.match(r.stderr, /not installed and answering/)
    } finally { nc.server.close() }
  })
  it('fails with 15 when the compose project has no nextcloud-app container', async () => {
    const t = setup(); const nc = await fakeNextcloud(t.occ)
    try {
      const r = await run('bash', [HOOK, 'seed'], hookEnv(t, nc.port, { FAKE_PROJECT: 'someone-else' }))
      assert.equal(r.status, 15, r.stderr)
      assert.match(r.stderr, /expected one running nextcloud-app container in project nc-demo/)
      assert.equal(JSON.parse(read(t.occ)).log.length, 0, 'no occ call reached another project')
    } finally { nc.server.close() }
  })
})
