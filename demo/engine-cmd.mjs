// Talk to the LOCAL IDEA Engine through its store, the same command queue the
// Console and the Engine `client` CLI use (engineDB[<engine>].commands), and
// read the result from the Engine's command log (traces). No docker, no compose.
//
// Run from a folder whose node_modules is the Engine's (install-demo.sh links it):
//   node engine-cmd.mjs ENGINE_DIR list            -> JSON: instances on disks docked here
//   node engine-cmd.mjs ENGINE_DIR disks           -> JSON: disks docked here
//   node engine-cmd.mjs ENGINE_DIR send <command>  -> waits for the trace; exit 0 ok, 1 error, 2 timeout
// Env: ENGINE_CMD_TIMEOUT seconds (default 900).
import { Repo } from '@automerge/automerge-repo'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import fs from 'fs'
import os from 'os'
import path from 'path'

const [dir, verb, ...rest] = process.argv.slice(2)
if (!dir || !['list', 'disks', 'send'].includes(verb) || (verb === 'send' && !rest.length)) {
  console.error('usage: engine-cmd.mjs ENGINE_DIR list|disks|send <command>'); process.exit(64)
}
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').trim()
const port = (read('config.yaml').match(/^\s*port:\s*(\d+)/m) || [])[1] || '4321'
const repo = new Repo({ network: [new WebSocketClientAdapter('ws://127.0.0.1:' + port)] })
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(what + ' timed out')), ms))])
let store, log
try {
  store = await withTimeout(repo.find(read('store-identity/store-url.txt').replace('automerge:', '')), 30000, 'store')
  await store.whenReady()
  log = await withTimeout(repo.find(read('store-identity/command-log-url.txt').replace('automerge:', '')), 30000, 'command log')
  await log.whenReady()
} catch (e) { console.error('ERROR: Engine store not reachable: ' + e.message); process.exit(3) }
await new Promise(r => setTimeout(r, 1500))
const s = store.doc()
const eng = Object.values(s.engineDB ?? {}).find(e => e?.hostname === os.hostname())
if (!eng) { console.error('ERROR: no engine with hostname ' + os.hostname() + ' in the store'); process.exit(3) }
const docked = Object.values(s.diskDB ?? {}).filter(d => d?.dockedTo === eng.id && d.device)

if (verb === 'disks') {
  console.log(JSON.stringify(docked.map(d => ({ id: d.id, name: d.name, device: d.device }))))
} else if (verb === 'list') {
  const ids = new Set(docked.map(d => d.id))
  console.log(JSON.stringify(Object.values(s.instanceDB ?? {}).filter(i => i && ids.has(i.storedOn)).map(i => {
    const d = s.diskDB[i.storedOn]
    return { id: i.id, name: i.name, status: i.status, port: i.port ?? null, storedOn: i.storedOn, device: d.device, diskName: d.name }
  })))
} else {
  const cmd = rest.join(' '), name = cmd.split(/\s+/)[0], t0 = Date.now()
  store.change(d => { d.engineDB[eng.id].commands.push(cmd) })
  console.error('sent: ' + cmd)
  const limit = Number(process.env.ENGINE_CMD_TIMEOUT || 900)
  for (let k = 0; k < limit; k++) {
    await new Promise(r => setTimeout(r, 1000))
    const t = Object.values(log.doc()?.traces ?? {}).find(t => t && t.command === name && t.startedAt >= t0 - 2000 && t.completedAt && t.status !== 'running')
    if (t) { console.log(JSON.stringify({ command: name, status: t.status, error: t.error ?? null })); process.exit(t.status === 'ok' ? 0 : 1) }
  }
  console.log(JSON.stringify({ command: name, status: 'timeout' })); process.exit(2)
}
process.exit(0)
