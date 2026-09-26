#!/usr/bin/env bash
# Wait until no game is in progress on the live server (two checks in a row, 2 minutes apart), then deploy.
# Usage: deploy/deploy-when-idle.sh [root@HOST]   (default from deploy/.env; same env as deploy.sh: BUNKER_SRC, BUNKER_SSH_KEY)
set -euo pipefail
[ -f "$(dirname "$0")/.env" ] && . "$(dirname "$0")/.env"
TARGET="${1:-${BUNKER_DEPLOY_TARGET:-}}"
[ -n "$TARGET" ] || { echo "Set BUNKER_DEPLOY_TARGET (e.g. root@1.2.3.4) in deploy/.env or pass it as the first argument." >&2; exit 2; }
KEY="${BUNKER_SSH_KEY:-$HOME/.ssh/id_ed25519_bunker}"
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o BatchMode=yes"
INTERVAL="${IDLE_INTERVAL:-120}"
idle=0
while :; do
  STATS=$($SSH "$TARGET" "curl -s --max-time 3 127.0.0.1:8080/stats" 2>/dev/null || true)
  ACTIVE=$(printf '%s' "$STATS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["activeGames"])' 2>/dev/null || echo "?")
  if [ "$ACTIVE" = "?" ]; then   # older build without /stats: idle = no live connections at all
    N=$($SSH "$TARGET" "ss -Htn state established '( sport = :8080 )' | wc -l" 2>/dev/null || echo 1)
    ACTIVE=$([ "$N" -eq 0 ] && echo 0 || echo "conn:$N")
  fi
  echo "$(date +%H:%M:%S) activeGames=$ACTIVE"
  if [ "$ACTIVE" = 0 ]; then idle=$((idle+1)); else idle=0; fi
  [ "$idle" -ge 2 ] && break
  sleep "$INTERVAL"
done
exec "$(dirname "$0")/deploy.sh" "$TARGET"
