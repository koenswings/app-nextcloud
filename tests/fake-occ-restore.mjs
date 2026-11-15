#!/usr/bin/env node
// fake-occ-restore.mjs — occ for 00-idea-restore.sh: logs calls; FAKE_OCC_SCAN_FAIL=1 fails files:scan.
import { readFileSync, writeFileSync } from 'node:fs'
const path = process.env.FAKE_OCC_STATE
const s = JSON.parse(readFileSync(path, 'utf8'))
const a = process.argv.slice(2)
s.calls = [...(s.calls ?? []), a]
writeFileSync(path, JSON.stringify(s))
if (a[0] === 'maintenance:mode') { console.log(a[1] === '--off' ? 'Maintenance mode disabled' : 'Maintenance mode enabled'); process.exit(0) }
if (a[0] === 'files:scan') process.exit(process.env.FAKE_OCC_SCAN_FAIL === '1' ? 1 : 0)
process.exit(1)
