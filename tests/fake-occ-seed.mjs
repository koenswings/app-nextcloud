// Fake occ for demo/seed_nextcloud.py (engine#369 hook). State: $FAKE_OCC
// JSON { installed, users: {uid: {display, pass, groups:[]}}, groups: {gid: {display}}, log: [] }.
// Passwords come only from OC_PASS (--password-from-env), like the real occ.
import fs from 'node:fs'
const f = process.env.FAKE_OCC
const st = JSON.parse(fs.readFileSync(f, 'utf8'))
const a = process.argv.slice(2)
const save = () => fs.writeFileSync(f, JSON.stringify(st, null, 1))
const opt = (name) => { const i = a.indexOf(name); return i >= 0 ? a[i + 1] : undefined }
const opts = (name) => a.flatMap((v, i) => (v === name ? [a[i + 1]] : []))
const fail = (msg) => { console.error(msg); save(); process.exit(1) }
const json = (v) => console.log(JSON.stringify(v))
if (a[0] !== 'status') st.log.push(a.join(' '))
switch (a[0]) {
  case 'status': json({ installed: !!st.installed, maintenance: false, needsDbUpgrade: false }); process.exit(0)
  case 'group:list': {
    const out = {}
    for (const g of Object.keys(st.groups)) out[g] = Object.keys(st.users).filter(u => st.users[u].groups.includes(g))
    json(out); break
  }
  case 'user:list': json(Object.fromEntries(Object.entries(st.users).map(([u, v]) => [u, v.display ?? u]))); break
  case 'group:add': {
    const gid = a.at(-1)
    if (st.groups[gid]) fail(`Group "${gid}" already exists.`)
    st.groups[gid] = { display: opt('--display-name') ?? gid }; break
  }
  case 'user:add': {
    const uid = a.at(-1)
    if (st.users[uid]) fail(`The user "${uid}" already exists.`)
    if (!a.includes('--password-from-env') || !process.env.OC_PASS) fail('--password-from-env given, but OC_PASS is empty!')
    for (const g of opts('--group')) if (!st.groups[g]) st.groups[g] = { display: g }
    st.users[uid] = { display: opt('--display-name') ?? uid, pass: process.env.OC_PASS, groups: opts('--group') }; break
  }
  case 'user:resetpassword': st.users[a.at(-1)].pass = process.env.OC_PASS; break
  case 'user:modify': if (a[2] === 'displayname') st.users[a[1]].display = a[3]; break
  case 'group:adduser': {
    const [, g, u] = a
    if (!st.groups[g]) fail(`Group not found`)
    if (!st.users[u].groups.includes(g)) st.users[u].groups.push(g); break
  }
  default: fail(`fake occ: unknown command ${a[0]}`)
}
save()
