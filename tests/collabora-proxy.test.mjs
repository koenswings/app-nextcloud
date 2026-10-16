// Office (CODE) without a host port: compose + the Apache proxy the root entrypoint writes.
// Run: node --test tests/
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const compose = readFileSync(join(root, 'compose.yaml'), 'utf8')
const service = name => compose.split(/\n  (?=[a-z][\w-]*:\n)/).find(b => b.startsWith(`${name}:`)) ?? ''

it('compose: CODE publishes no host port (no shared 9980), Office goes through this Nextcloud', () => {
  assert.ok(service('code'), 'code service exists')
  assert.ok(!/^\s+ports:/m.test(service('code')), 'code has no ports:')
  assert.ok(!/9980:9980/.test(compose), 'no fixed 9980 host port anywhere')
  assert.match(service('code'), /ssl\.enable=false --o:ssl\.termination=false/)
  assert.match(service('code'), /- backend/)
  assert.match(compose, /IDEA_COLLABORA_URL=http:\/\/\$\{ip\}:\$\{port\}/)
  assert.match(compose, /IDEA_COLLABORA_PROXY=http:\/\/code:9980/)
})

function runEntrypoint(env) {
  const dir = mkdtempSync(join(tmpdir(), 'idea-proxy-'))
  const apache = join(dir, 'apache2'); mkdirSync(join(apache, 'sites-enabled'), { recursive: true })
  const site = join(apache, 'sites-enabled/000-default.conf')
  writeFileSync(site, '<VirtualHost *:80>\n\tDocumentRoot /var/www/html\n</VirtualHost>\n')
  const a2log = join(dir, 'a2.log'), a2 = join(dir, 'a2enmod'), ep = join(dir, 'ep.sh')
  writeFileSync(a2, `#!/bin/sh\necho "$@" >> ${a2log}\n`, { mode: 0o755 })
  writeFileSync(ep, '#!/bin/sh\necho "EXEC $@"\n', { mode: 0o755 })
  const run = () => spawnSync('sh', [join(root, 'idea-files-entrypoint.sh')], { encoding: 'utf8', env: { PATH: process.env.PATH,
    IDEA_FILES_ROOT: join(dir, 'none'), IDEA_ENTRYPOINT: ep, IDEA_APACHE_DIR: apache, IDEA_A2ENMOD: a2, ...env } })
  return { run, apache, site, a2log }
}

it('entrypoint: proxies /browser, /hosting and the /cool websocket to the instance CODE, Include once', () => {
  const t = runEntrypoint({ IDEA_COLLABORA_PROXY: 'http://code:9980' })
  for (let i = 0; i < 2; i++) { const r = t.run(); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /EXEC apache2-foreground/) }
  const conf = readFileSync(join(t.apache, 'idea-collabora.conf'), 'utf8')
  for (const l of ['ProxyPass           /browser http://code:9980/browser retry=0', 'ProxyPass           /hosting/discovery http://code:9980/hosting/discovery',
    'ProxyPassMatch      "/cool/(.*)/ws$" ws://code:9980/cool/$1/ws nocanon', 'ProxyPass           /cool http://code:9980/cool', 'AllowEncodedSlashes NoDecode'])
    assert.ok(conf.includes(l), l)
  const site = readFileSync(t.site, 'utf8')
  assert.equal(site.match(/Include .*idea-collabora\.conf/g).length, 1, 'Include added once, inside the vhost')
  assert.ok(site.indexOf('Include') < site.indexOf('</VirtualHost>'))
  assert.match(readFileSync(t.a2log, 'utf8'), /proxy proxy_http proxy_wstunnel/)
})

it('entrypoint: no IDEA_COLLABORA_PROXY (old compose) -> no proxy config, Nextcloud still starts', () => {
  const t = runEntrypoint({})
  const r = t.run(); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /EXEC/)
  assert.ok(!existsSync(join(t.apache, 'idea-collabora.conf')))
  assert.ok(!existsSync(t.a2log))
})

it('entrypoint: a failing a2enmod only warns (fail open)', () => {
  const t = runEntrypoint({ IDEA_COLLABORA_PROXY: 'http://code:9980', IDEA_A2ENMOD: 'false' })
  const r = t.run(); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /WARNING a2enmod failed/); assert.match(r.stdout, /EXEC/)
})
