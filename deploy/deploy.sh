#!/usr/bin/env bash
# Ship the app to the Pi and restart it. First-time setup (venv, service, Caddy, DNS) is in README.md.
set -euo pipefail
HOST=${1:-pihole}
cd "$(dirname "$0")/.."
python3 -m unittest discover tests -q
node --test tests/*.test.mjs >/dev/null
rsync -az --delete --exclude .git --exclude data --exclude .venv --exclude '__pycache__' ./ "$HOST":context-reader/
ssh "$HOST" 'sudo systemctl restart context-reader && sleep 1 && systemctl is-active context-reader'
