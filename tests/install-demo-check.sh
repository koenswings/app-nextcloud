#!/usr/bin/env bash
# Checks a running Nextcloud Demo (after demo/install-demo.sh): logins and the demo files.
# Usage: tests/install-demo-check.sh http://127.0.0.1:<port>   (exit 0 = all PASS)
set -euo pipefail
U="${1:?url}"; fail() { echo "FAIL: $*"; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' -u "$1:$2" -X PROPFIND -H 'Depth: 0' "$U/remote.php/dav/files/$1/"; }
for u in admin teacher1 teacher2 learner1 learner2 learner3; do
  [ "$(code $u "${u}911!")" = 207 ] || fail "$u with ${u}911!"
  [ "$(code $u wrong-pass)" = 401 ] || fail "$u wrong password not refused"
done; echo "PASS admin, teacher1-2, learner1-3 sign in with <name>911! (wrong password refused)"
for u in admin teacher1 learner1; do
  n=$(curl -s -u "$u:${u}911!" -X PROPFIND -H 'Depth: infinity' "$U/remote.php/dav/files/$u/IDEA%20Demo/" | grep -o '<d:getcontentlength>' | wc -l)
  [ "$n" = 4 ] || fail "$u sees $n files in IDEA Demo (want 4)"
done; echo "PASS IDEA Demo (Worksheets + Teacher Notes, 4 files) visible to admin, teacher1 and learner1"
