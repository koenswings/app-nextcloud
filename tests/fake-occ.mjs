#!/usr/bin/env node
// fake-occ.mjs — occ subset used by the install/Office/Files hooks, on a JSON state file.
// State (FAKE_OCC_STATE): { installed, online, appsPresent[], appsEnabled[], app:{app:{k:v}}, system:{}, mounts:[], calls:[] }
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const path = process.env.FAKE_OCC_STATE
const s = JSON.parse(readFileSync(path, 'utf8'))
const a = process.argv.slice(2)
s.calls = [...(s.calls ?? []), a]
s.appsPresent ??= []; s.appsEnabled ??= []; s.app ??= {}; s.system ??= {}; s.mounts ??= []
const out = (code, text) => { writeFileSync(path, JSON.stringify(s, null, 2)); if (text) console.log(text); process.exit(code) }
const val = () => (a.find(x => x.startsWith('--value=')) ?? '').slice(8)
const [cmd] = a
if (cmd === 'status') out(0, `  - installed: ${s.installed ? 'true' : 'false'}`)
if (cmd === 'maintenance:install') { s.installed = true; out(0, 'Nextcloud was successfully installed') }
if (!s.installed) out(1, 'Nextcloud is not installed - only a limited number of commands are available')
switch (cmd) {
  case 'app:list': out(0, s.appsEnabled.map(x => `  - ${x}: 1.0`).join('\n'))
  case 'app:enable':
    // Present = shipped with core (appsPresent) or code found in custom_apps (bundled-apps hook).
    if (!s.appsPresent.includes(a[1]) && !(process.env.IDEA_CUSTOM_APPS && existsSync(join(process.env.IDEA_CUSTOM_APPS, a[1], 'appinfo/info.xml')))) out(1, `${a[1]} not found`)
    if (!s.appsEnabled.includes(a[1])) s.appsEnabled.push(a[1]); out(0)
  case 'app:install':
    if (!s.online) out(1, `Could not download app ${a[1]}`)
    s.appsPresent.push(a[1]); s.appsEnabled.push(a[1]); out(0)
  case 'config:app:get': { const v = s.app[a[1]]?.[a[2]]; v === undefined ? out(1) : out(0, v) }
  case 'config:app:set': (s.app[a[1]] ??= {})[a[2]] = val(); out(0)
  case 'config:system:get': { const v = s.system[a[1]]; v === undefined ? out(1) : out(0, String(v)) }
  case 'config:system:set': s.system[a[1]] = a.includes('--type=boolean') ? val() === 'true' : val(); out(0)
  case 'richdocuments:activate-config': (s.app.richdocuments ??= {}).discovery_fetched = s.app.richdocuments.wopi_url ?? ''; out(0)
  case 'files_external:list': out(0, JSON.stringify(s.mounts))
  case 'files_external:create': {
    const id = s.mounts.length + 1
    s.mounts.push({ mount_id: id, mount_point: '/' + a[1], configuration: { datadir: a.find(x => x.startsWith('datadir=')).slice(8) }, options: {} })
    out(0, String(id))
  }
  case 'files_external:option': { const m = s.mounts.find(m => String(m.mount_id) === a[1]); m.options[a[2]] = a[3]; out(0) }
}
out(3, `fake-occ: unsupported ${a.join(' ')}`)
