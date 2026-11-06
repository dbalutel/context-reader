#!/usr/bin/env bash
# Let only Cloudflare reach ports 80/443 (run on the VPS with sudo). SSH stays open to everyone.
# Re-run it if Cloudflare publishes new ranges (cloudflare.com/ips).
set -euo pipefail
ranges=$(curl -fsS https://www.cloudflare.com/ips-v4/; echo; curl -fsS https://www.cloudflare.com/ips-v6/)
[ "$(echo "$ranges" | grep -c /)" -ge 10 ] || { echo "could not fetch Cloudflare ranges" >&2; exit 1; }
for rule in 80/tcp 443/tcp 443/udp; do ufw delete allow "$rule" >/dev/null 2>&1 || true; done
for r in $ranges; do
    for port in 80 443; do ufw allow proto tcp from "$r" to any port "$port" comment cloudflare >/dev/null; done
done
ufw reload >/dev/null
echo "ports 80/443 open to $(echo "$ranges" | grep -c /) Cloudflare ranges"
