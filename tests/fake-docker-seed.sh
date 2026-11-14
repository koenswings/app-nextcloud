#!/bin/sh
# Fake docker for demo/seed_nextcloud.py tests: `ps` answers for the expected compose
# project only; `exec -u 33 [-e OC_PASS] <cid> php occ ...` runs tests/fake-occ-seed.mjs.
# Every call's argv is appended to $FAKE_DOCKER_LOG.
echo "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  ps)
    case "$*" in
      *"label=com.docker.compose.project=$FAKE_PROJECT "*"label=com.docker.compose.service=nextcloud-app"*) echo "c0ffee123456" ;;
    esac
    exit 0 ;;
  exec)
    shift
    while [ $# -gt 0 ]; do
      case "$1" in
        -u|-e) shift 2 ;;
        c0ffee123456) shift; break ;;
        *) echo "fake docker: unexpected exec arg $1" >&2; exit 125 ;;
      esac
    done
    [ "$1 $2" = "php occ" ] || { echo "fake docker: not occ: $*" >&2; exit 126; }
    shift 2
    exec node "$(dirname "$0")/fake-occ-seed.mjs" "$@" ;;
esac
echo "fake docker: unsupported $1" >&2; exit 1
