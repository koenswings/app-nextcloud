#!/usr/bin/env node
// fake-occ-files.mjs — occ subset used by before-starting/10-idea-files.sh, on a JSON state file.
// State (FAKE_OCC_STATE): { installed, notReady (status fails this many times), groups{}, mounts[], calls[] }
import { readFileSync, writeFileSync } from 'node:fs'
const path = process.env.FAKE_OCC_STATE
const s = JSON.parse(readFileSync(path, 'utf8'))
const a = process.argv.slice(2)
s.calls = [...(s.calls ?? []), a]
s.mounts ??= []; s.groups ??= { admin: ['admin'] }
const out = (code, text) => { writeFileSync(path, JSON.stringify(s, null, 2)); if (text) console.log(text); process.exit(code) }
const [cmd] = a
if (cmd === 'status') {
  if ((s.notReady ?? 0) > 0) { s.notReady--; out(1, 'SQLSTATE[HY000] [2002] Connection refused') }
  out(0, `  - installed: ${s.installed === false ? 'false' : 'true'}`)
}
const mount = id => s.mounts.find(m => String(m.mount_id) === String(id))
switch (cmd) {
  case 'app:enable': out(0)
  case 'group:list': out(0, JSON.stringify(s.groups))
  case 'group:add': if (s.groups[a[1]]) out(1, 'Group exists'); s.groups[a[1]] = []; out(0)
  case 'files_external:list': out(0, JSON.stringify(s.mounts))
  case 'files_external:create': {
    const id = Math.max(0, ...s.mounts.map(m => m.mount_id)) + 1
    s.mounts.push({ mount_id: id, mount_point: '/' + a[1], configuration: { datadir: a.find(x => x.startsWith('datadir=')).slice(8) },
      options: { enable_sharing: false }, applicable_users: [], applicable_groups: [] })
    out(0, String(id))
  }
  case 'files_external:option': { const m = mount(a[1]); if (!m) out(1); m.options[a[2]] = a[3] === 'true' ? true : a[3] === '1' ? 1 : a[3]; out(0) }
  case 'files_external:applicable': {
    const m = mount(a[1]); if (!m) out(1)
    for (const x of a.slice(2)) if (x.startsWith('--add-group=')) {
      const g = x.slice(12); if (!s.groups[g]) out(1, `Group ${g} not found`)
      if (!m.applicable_groups.includes(g)) m.applicable_groups.push(g)
    }
    out(0)
  }
  case 'files_external:delete': s.mounts = s.mounts.filter(m => String(m.mount_id) !== a[2]); out(0)
}
out(3, `fake-occ: unsupported ${a.join(' ')}`)
