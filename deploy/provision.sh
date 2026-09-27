#!/usr/bin/env bash
# One-time server setup (Ubuntu 24.04, run as root on the server). Idempotent.
# Usage: ssh root@HOST 'bash -s' -- <public-hostname> [redirect-hostname ...] < deploy/provision.sh
#   Extra hostnames (e.g. www.example.com, an old 1-2-3-4.sslip.io link) permanently redirect to the first one.
set -euo pipefail
HOSTNAME_PUBLIC="${1:?public hostname, e.g. 1-2-3-4.sslip.io}"
shift
REDIRECT_HOSTS=("$@")
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg rsync ufw debian-keyring debian-archive-keyring apt-transport-https >/dev/null

# Node.js 24 LTS (NodeSource)
if ! node --version 2>/dev/null | grep -q '^v24'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

# Caddy (official repo) — automatic HTTPS
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

id bunker >/dev/null 2>&1 || useradd --system --home /opt/bunker --shell /usr/sbin/nologin bunker
mkdir -p /opt/bunker && chown -R bunker:bunker /opt/bunker

cat > /etc/systemd/system/bunker.service <<UNIT
[Unit]
Description=Bunker Online game server
After=network-online.target
Wants=network-online.target

[Service]
User=bunker
Group=bunker
WorkingDirectory=/opt/bunker
Environment=NODE_ENV=production PORT=8080 HOST=127.0.0.1 BUNKER_TRUST_PROXY=1
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadOnlyPaths=/opt/bunker

[Install]
WantedBy=multi-user.target
UNIT

IP4=$(curl -s -4 --max-time 5 https://ifconfig.me || true)
{
  # /audio/* is served by Caddy itself: HTTP Range support (Safari/iOS needs it for media) + caching.
  printf '%s {\n\tencode gzip\n\thandle /audio/* {\n\t\troot * /opt/bunker/public\n\t\theader Cache-Control "public, max-age=604800"\n\t\tfile_server\n\t}\n\thandle {\n\t\treverse_proxy 127.0.0.1:8080\n\t}\n}\n' "$HOSTNAME_PUBLIC"
  if [ "${#REDIRECT_HOSTS[@]}" -gt 0 ]; then
    printf '%s {\n\tredir https://%s{uri} permanent\n}\n' "$(IFS=,; echo "${REDIRECT_HOSTS[*]}" | sed 's/,/, /g')" "$HOSTNAME_PUBLIC"
  fi
  if [ -n "$IP4" ]; then
    printf 'http://%s {\n\tredir https://%s{uri}\n}\n' "$IP4" "$HOSTNAME_PUBLIC"
  fi
} > /etc/caddy/Caddyfile

printf "PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n" > /etc/ssh/sshd_config.d/00-hardening.conf
sshd -t && systemctl reload ssh

ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

systemctl daemon-reload
systemctl enable bunker >/dev/null 2>&1
systemctl reload-or-restart caddy
echo "node $(node --version), caddy $(caddy version | cut -d' ' -f1), ufw $(ufw status | head -1)"
