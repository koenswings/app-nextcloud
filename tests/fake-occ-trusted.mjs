#!/usr/bin/env node
// fake-occ-trusted.mjs — the occ subset 20-idea-trusted-domains.sh uses, on a JSON state file.
//   status | config:system:get <key> | config:system:set <key> <index> --value=<v> | config:system:delete <key> [<index>]
// State (FAKE_OCC_STATE): { ready: bool, failSet: bool, system: { <key>: string[] | string }, calls: string[][] }
// Arrays print one value per line, like occ. Like real occ (PHP unset), deleting index N
// only removes that slot: a hole (null) stays and later indexes do not shift.
import { readFileSync, writeFileSync } from 'node:fs'
const path = process.env.FAKE_OCC_STATE
const s = JSON.parse(readFileSync(path, 'utf8'))
const args = process.argv.slice(2)
s.calls = [...(s.calls ?? []), args]
const save = () => writeFileSync(path, JSON.stringify(s, null, 2))
const [cmd, key, index] = args
if (!s.ready) { save(); process.stderr.write('Nextcloud is not installed\n'); process.exit(1) }
s.system = s.system ?? {}
if (cmd === 'status') { save(); console.log('  - installed: true'); process.exit(0) }
if (cmd === 'config:system:get') {
  save()
  const v = s.system[key]
  if (v === undefined) process.exit(1)
  console.log(Array.isArray(v) ? v.filter(x => x !== null).join('\n') : String(v))
  process.exit(0)
}
if (cmd === 'config:system:set') {
  if (s.failSet) { save(); process.exit(1) }
  const value = (args.find(a => a.startsWith('--value=')) ?? '').slice('--value='.length)
  const arr = Array.isArray(s.system[key]) ? s.system[key] : []
  const i = parseInt(index, 10)
  if (i > arr.length) { save(); process.stderr.write(`index gap ${i}\n`); process.exit(2) }
  arr[i] = value
  s.system[key] = arr
  save(); process.exit(0)
}
if (cmd === 'config:system:delete') {
  if (index === undefined) delete s.system[key]
  else if (Array.isArray(s.system[key])) {
    const i = parseInt(index, 10)
    const arr = s.system[key]
    if (i < arr.length) arr[i] = null
    while (arr.length && arr[arr.length - 1] === null) arr.pop()   // trailing holes are invisible
  }
  save(); process.exit(0)
}
save(); process.stderr.write(`fake-occ: unsupported ${args.join(' ')}\n`); process.exit(3)
