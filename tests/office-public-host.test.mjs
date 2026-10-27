// idea#212: Office URL on a public host (wh over Tailscale) and configurable CODE home_mode.
// Resolves compose's ${VAR:-default} / ${VAR:+alt} (nested) with a small interpolator.
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const c = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'compose.yaml'), 'utf8')
function interp(s, env) {
  let out = '', i = 0
  while (i < s.length) {
    if (s[i] === '$' && s[i + 1] === '{') {
      let d = 1, j = i + 2
      while (d) { if (s[j] === '{') d++; else if (s[j] === '}') d--; j++ }
      const body = s.slice(i + 2, j - 1), m = body.match(/^(\w+)(?:(:-|:\+)([\s\S]*))?$/)
      const v = env[m[1]] ?? ''
      out += !m[2] ? v : m[2] === ':-' ? (v !== '' ? v : interp(m[3], env)) : (v !== '' ? interp(m[3], env) : '')
      i = j
    } else out += s[i++]
  }
  return out
}
const line = key => c.match(new RegExp(`^\\s+- ${key}=(.*)$`, 'm'))[1]
const school = { ip: '10.42.0.11', port: '18280' }
const wh = { ...school, ip: '192.168.1.20', IDEA_PUBLIC_HOST: '100.115.60.6', IDEA_COLLABORA_HOME_MODE: 'true' }

it('school Pi (no IDEA_PUBLIC_HOST): Office and CODE stay on the LAN IP, nothing extra trusted', () => {
  assert.equal(interp(line('IDEA_COLLABORA_URL'), school), 'http://10.42.0.11:18280')
  assert.equal(interp(line('server_name'), school), '10.42.0.11:18280')
  assert.equal(interp(line('IDEA_HOST_IPS'), school), '10.42.0.11')
})
it('wh (IDEA_PUBLIC_HOST=Tailscale IP): public wopi URL, CODE server_name and trusted_domains use it', () => {
  assert.equal(interp(line('IDEA_COLLABORA_URL'), wh), 'http://100.115.60.6:18280')
  assert.equal(interp(line('server_name'), wh), '100.115.60.6:18280')
  assert.equal(interp(line('IDEA_HOST_IPS'), wh), '192.168.1.20,100.115.60.6')
  assert.equal(interp(line('IDEA_COLLABORA_INTERNAL_URL'), wh), 'http://code:9980', 'server-side wopi_url stays internal')
})
it('home_mode is off by default (20-connection cap) and on when IDEA_COLLABORA_HOME_MODE=true', () => {
  assert.match(interp(line('extra_params'), school), /--o:home_mode\.enable=false$/)
  assert.match(interp(line('extra_params'), wh), /--o:home_mode\.enable=true$/)
  assert.match(interp(line('extra_params'), wh), /--o:ssl\.enable=false --o:ssl\.termination=false/)
})
