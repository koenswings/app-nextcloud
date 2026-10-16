// Fake occ for demo/install-demo.sh. State: $FAKE_OCC (JSON {users:{name:{groups:[],pass}}, log:[]}).
import fs from 'node:fs'
const f = process.env.FAKE_OCC, st = JSON.parse(fs.readFileSync(f, 'utf8'))
const a = process.argv.slice(2)
if (a[0] === 'status') { console.log(`  - installed: ${process.env.FAKE_NOT_INSTALLED ? 'false' : 'true'}`); process.exit(0) }  // not logged
st.log.push(a.join(' '))
const save = () => fs.writeFileSync(f, JSON.stringify(st))
const last = a.at(-1)
switch (a[0]) {
  case 'user:list': console.log(JSON.stringify(Object.fromEntries(Object.keys(st.users).map(u => [u, u])))); break
  case 'user:add': if (st.users[last]) { save(); process.exit(1) }
    st.users[last] = { groups: [a[a.indexOf('--group') + 1]], pass: process.env.OC_PASS }; break
  case 'user:resetpassword': st.users[last].pass = process.env.OC_PASS; break
  case 'group:adduser': { const g = st.users[last].groups; if (!g.includes(a[1])) g.push(a[1]); break }
}
save()
