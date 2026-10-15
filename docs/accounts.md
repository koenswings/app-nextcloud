# Default accounts and passwords

IDEA rule (Koen): every app account's default password is `<account name>911!`.
Easy to type on purpose; change it before real use. Internal DB passwords stay
generated (`${pass}` from the Engine).

| Account | Default password | Group | Created by |
|---|---|---|---|
| `admin` | `admin911!` | admin | image auto-install (`NEXTCLOUD_ADMIN_*` in compose) |
| `teacher1` | `teacher1911!` | teachers | `before-starting/20-idea-accounts.sh` |
| `learner1` | `learner1911!` | learners | `before-starting/20-idea-accounts.sh` |

- `IDEA_NC_ADMIN_PASSWORD` still overrides the admin password. Its fallback is
  now `admin911!` (it was the generated `${pass}`, a random hard-to-type value).
  It only matters at first-start install; an existing admin is never reset.
- `IDEA_NC_SEED_USERS` (default `teacher1:teachers learner1:learners`) lists
  `user:group` pairs; `IDEA_NC_SEED_USERS=` (empty) creates none. Missing users
  are created; existing users and passwords are never changed.

## Password policy

Nextcloud 31's `password_policy` defaults are minLength **10** and the
HaveIBeenPwned check. Verified on `nextcloud:31.0.1-apache`: `admin911!` is
rejected ("at least 10 characters … compromised password list"). The hook sets
`minLength=9` and `enforceHaveIBeenPwned=false` **only if the admin never set
them**; the common-password rule and everything else stay on. With that,
`admin911!`, `teacher1911!`, `learner1911!` are accepted (verified on the real
image). Automated: `tests/accounts-hook.test.mjs` (fake occ that enforces the
NC 31 defaults).
