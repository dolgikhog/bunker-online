#!/usr/bin/env bash
# Push the current code to the server and restart the game.
# Usage: deploy/deploy.sh [root@HOST]   (default: BUNKER_DEPLOY_TARGET from deploy/.env)
# BUNKER_SRC=<dir> deploys another checkout (e.g. .hotfix/live) instead of the repo root.
set -euo pipefail
[ -f "$(dirname "$0")/.env" ] && . "$(dirname "$0")/.env"
TARGET="${1:-${BUNKER_DEPLOY_TARGET:-}}"
[ -n "$TARGET" ] || { echo "Set BUNKER_DEPLOY_TARGET (e.g. root@1.2.3.4) in deploy/.env or pass it as the first argument." >&2; exit 2; }
KEY="${BUNKER_SSH_KEY:-$HOME/.ssh/id_ed25519_bunker}"
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new"
cd "$(dirname "$0")/.."
# Refuse to restart while a game is in progress (a restart ends every game; state is in memory).
# Uses GET /stats (SPEC X8, loopback-only) when the server has it; otherwise counts live connections.
if [ "${FORCE:-0}" != 1 ]; then
  STATS=$($SSH "$TARGET" "curl -s --max-time 3 127.0.0.1:8080/stats" 2>/dev/null || true)
  ACTIVE=$(printf '%s' "$STATS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["activeGames"])' 2>/dev/null || true)
  if [ -n "$ACTIVE" ]; then
    if [ "$ACTIVE" -gt 0 ]; then
      echo "ABORT: $ACTIVE game(s) in progress right now ($STATS)." >&2
      echo "Use deploy/deploy-when-idle.sh, try later, or FORCE=1 to deploy anyway." >&2
      exit 1
    fi
  else
    N=$($SSH "$TARGET" "ss -Htn state established '( sport = :8080 )' | wc -l")
    if [ "$N" -gt 0 ]; then
      echo "ABORT: $N live connection(s) to the game right now (no /stats on this build) - someone may be mid-game." >&2
      echo "Try again later, or run with FORCE=1 to deploy anyway." >&2
      exit 1
    fi
  fi
fi
SRC="${BUNKER_SRC:-.}"
# Stamp the build (SPEC X10): shown in the app and prefilled into issue reports. Git-ignored.
printf '{"version":"%s","builtAt":"%s"}\n' "$(git describe --always --dirty 2>/dev/null || echo unknown)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SRC/public/version.json"
rsync -az --delete -e "$SSH" \
  --include='/package.json' --include='/package-lock.json' \
  --include='/server/***' --include='/public/***' \
  --exclude='*' "$SRC/" "$TARGET:/opt/bunker/"
$SSH "$TARGET" 'cd /opt/bunker && chown -R bunker:bunker . && sudo -u bunker npm ci --omit=dev --no-audit --no-fund --silent && systemctl restart bunker && sleep 1 && systemctl is-active bunker && curl -s 127.0.0.1:8080/healthz && echo'
