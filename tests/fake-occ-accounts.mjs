#!/usr/bin/env node
// fake-occ-accounts.mjs — occ subset for 20-idea-accounts.sh, enforcing NC 31 password_policy
// defaults (minLength 10, HIBP on; values from password_policy stable31 PasswordPolicyConfig.php).
// State (FAKE_OCC_STATE): { installed, appConfig{}, users{name:{password,groups[]}}, groups{}, calls[] }
import { readFileSync, writeFileSync } from 'node:fs'
const path = process.env.FAKE_OCC_STATE
const s = JSON.parse(readFileSync(path, 'utf8'))
const a = process.argv.slice(2)
s.calls = [...(s.calls ?? []), a]; s.appConfig ??= {}; s.users ??= { admin: { password: 'admin911!', groups: ['admin'] } }; s.groups ??= { admin: [] }
s.pwned ??= ['admin911!', 'teacher1911!', 'learner1911!']  // pretend HIBP lists them
const out = (c, t) => { writeFileSync(path, JSON.stringify(s, null, 2)); if (t) console.log(t); process.exit(c) }
const opt = k => (a.find(x => x.startsWith(`--${k}=`)) ?? '').split('=').slice(1).join('=')
const cfg = (k, d) => (k in s.appConfig ? s.appConfig[k] : d)
switch (a[0]) {
  case 'status': out(0, `  - installed: ${s.installed === false ? 'false' : 'true'}`)
  case 'config:app:get': { const k = a[2]; if (a[1] !== 'password_policy' || !(k in s.appConfig)) out(1); out(0, String(s.appConfig[k])) }
  case 'config:app:set': s.appConfig[a[2]] = opt('type') === 'integer' ? Number(opt('value')) : opt('type') === 'boolean' ? opt('value') === 'true' : opt('value'); out(0)
  case 'user:info': out(s.users[a[1]] ? 0 : 1)
  case 'user:add': {
    const u = a[a.length - 1], pw = process.env.OC_PASS ?? ''
    if (s.users[u]) out(1, 'exists')
    if (pw.length < cfg('minLength', 10)) out(1, `Password needs to be at least ${cfg('minLength', 10)} characters long`)
    if (cfg('enforceHaveIBeenPwned', true) && s.pwned.includes(pw)) out(1, 'Password is present on the HaveIBeenPwned list')
    s.users[u] = { password: pw, groups: [] }; out(0)
  }
  case 'group:add': if (s.groups[a[1]]) out(1); s.groups[a[1]] = []; out(0)
  case 'group:adduser': { const [, g, u] = a; if (!s.groups[g] || !s.users[u]) out(1); if (!s.users[u].groups.includes(g)) s.users[u].groups.push(g); out(0) }
}
out(3, `fake-occ: unsupported ${a.join(' ')}`)
