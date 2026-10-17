// compose feeds the trusted-domains hook from the Engine's own .env keys (hostname=, ip=).
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const c = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'compose.yaml'), 'utf8')
it('IDEA_HOSTNAME and IDEA_HOST_IPS fall back to the Engine .env hostname and ip', () => {
  assert.match(c, /- IDEA_HOSTNAME=\$\{IDEA_HOSTNAME:-\$\{hostname:-\}\}/)
  assert.match(c, /- IDEA_HOST_IPS=\$\{IDEA_HOST_IPS:-\$\{ip:-\}\}/)
})
it('LAN subnet trust is on by default and can be turned off', () => {
  assert.match(c, /- IDEA_TRUST_LAN_SUBNET=\$\{IDEA_TRUST_LAN_SUBNET:-1\}/)
})
