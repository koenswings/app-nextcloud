// idea#247: demo/install-demo.sh finds instances on a data disk and on the Engine's system disk.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo', 'install-demo.sh')
const src = fs.readFileSync(script, 'utf8')
const fn = src.slice(src.indexOf('instance_dir() {'), src.indexOf('\n}\n', src.indexOf('instance_dir() {')) + 3)

const run = (env, dev, id) => execFileSync('bash', ['-c', `${fn}\ninstance_dir "$0" "$1"`, dev, id], { env: { ...process.env, ...env } }).toString().trim()

test('data disk: /disks/<dev>/instances/<id>', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'idir-'))
  fs.mkdirSync(path.join(t, 'disks/sda1/instances/x1'), { recursive: true })
  fs.mkdirSync(path.join(t, 'sys/x1'), { recursive: true })
  assert.equal(run({ DISKS_ROOT: path.join(t, 'disks'), SYSTEM_INSTANCES_ROOT: path.join(t, 'sys') }, 'sda1', 'x1'), path.join(t, 'disks/sda1/instances/x1'))
})

test('system disk: falls back to /instances/<id>', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'idir-'))
  fs.mkdirSync(path.join(t, 'sys/x2'), { recursive: true })
  assert.equal(run({ DISKS_ROOT: path.join(t, 'disks'), SYSTEM_INSTANCES_ROOT: path.join(t, 'sys') }, 'sda2', 'x2'), path.join(t, 'sys/x2'))
})

test('neither exists: keeps the data-disk path (callers report it missing)', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'idir-'))
  assert.equal(run({ DISKS_ROOT: path.join(t, 'disks'), SYSTEM_INSTANCES_ROOT: path.join(t, 'sys') }, 'sdb1', 'x3'), path.join(t, 'disks/sdb1/instances/x3'))
})
