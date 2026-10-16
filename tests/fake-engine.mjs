// Fake Engine command queue for demo/install-demo.sh tests.
// State: $FAKE_STATE (JSON {instances:[], disks:[], commands:[]}).
// send "<cmd>" parses quote-aware (the planned Engine fix) unless FAKE_OLD_PARSER=1 (split on spaces),
// appends to commands, and answers like a command-log trace. FAKE_FAIL=<command> -> status error.
import fs from 'node:fs'
const file = process.env.FAKE_STATE
const st = JSON.parse(fs.readFileSync(file, 'utf8'))
const [verb, cmd] = process.argv.slice(2)
const save = () => fs.writeFileSync(file, JSON.stringify(st, null, 1))
const parse = s => process.env.FAKE_OLD_PARSER === '1' ? s.trim().split(/\s+/)
  : [...s.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2])
if (verb === 'list') console.log(JSON.stringify(st.instances))
else if (verb === 'disks') console.log(JSON.stringify(st.disks))
else if (verb === 'send') {
  st.commands.push(cmd)
  const a = parse(cmd)
  if (process.env.FAKE_FAIL === a[0]) { save(); console.log(JSON.stringify({ command: a[0], status: 'error', error: 'boom' })); process.exit(1) }
  if (a[0] === 'installApp') {
    const i = a.indexOf('--name'), name = i > 0 ? a[i + 1] : a[1]
    const d = st.disks.find(d => d.id === a[2])
    st.instances.push({ id: 'nextcloud-demo', name, status: 'Stopped', port: 8099, storedOn: d.id, device: d.device, diskName: d.name })
  }
  const inst = st.instances.find(x => x.id === a[1])
  if (a[0] === 'stopInstance' && inst) inst.status = 'Stopped'
  if (a[0] === 'startInstance' && inst) inst.status = 'Running'
  save(); console.log(JSON.stringify({ command: a[0], status: 'ok', error: null }))
} else process.exit(64)
