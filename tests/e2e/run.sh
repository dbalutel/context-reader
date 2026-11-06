#!/usr/bin/env bash
# Browser tests in headless Chrome against the app with fake Claude and Google, on a throwaway data dir.
#   tests/e2e/run.sh                 # all specs
#   tests/e2e/run.sh install.mjs     # one spec
#   SKIP_STORE=1 tests/e2e/run.sh    # without the live Project Gutenberg store section
# Needs Google Chrome (or CHROME=/path/to/chrome) and Node; screenshots land in tests/e2e/shots/.
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci --silent
PY=../../.venv/bin/python
[ -x "$PY" ] || PY=python3

DATA=$(mktemp -d)
PORT=${PORT:-8199}
READER_DATA=$DATA READER_PORT=$PORT "$PY" fake_server.py >"$DATA/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; rm -rf "$DATA"' EXIT
for _ in $(seq 50); do curl -sf "http://127.0.0.1:$PORT/" >/dev/null && break; sleep 0.2; done

specs=("$@")
[ ${#specs[@]} -gt 0 ] || specs=(reader.mjs install.mjs passkey.mjs)
status=0
for spec in "${specs[@]}"; do
    echo "== $spec"
    if BASE="http://127.0.0.1:$PORT" node "$spec" >"$DATA/out.log" 2>&1; then
        grep -E '^(PASS|SKIP)' "$DATA/out.log" || true
    else
        status=1
        grep -E '^(PASS|FAIL|SKIP)' "$DATA/out.log" || true
        echo "-- $spec output (tail):"; tail -15 "$DATA/out.log"
    fi
done
if [ $status = 0 ]; then echo "all browser tests passed"; else echo "browser tests FAILED"; echo "-- server log (tail):"; tail -15 "$DATA/server.log"; fi
exit $status
