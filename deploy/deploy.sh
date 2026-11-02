#!/usr/bin/env bash
# Ship the app to the Pi and restart it. First-time setup (venv, service, Caddy, DNS) is in README.md.
set -euo pipefail
HOST=${1:-pihole}
cd "$(dirname "$0")/.."
# unit tests run with the same anthropic SDK as the Pi (requirements.txt) in a local .venv
[ -x .venv/bin/python ] || { python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; }
.venv/bin/python -m unittest discover tests -q
node --test tests/*.test.mjs >/dev/null
rsync -az --delete --exclude .git --exclude data --exclude .venv --exclude '__pycache__' \
    --exclude tests/e2e/node_modules --exclude tests/e2e/shots --exclude tests/fixtures ./ "$HOST":context-reader/
ssh "$HOST" 'sudo systemctl restart context-reader && sleep 1 && systemctl is-active context-reader'
