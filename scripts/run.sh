#!/usr/bin/env bash
# Convenience launcher.  Usage: scripts/run.sh [ssh|local|mock]
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-${HM_SOURCE:-mock}}"
export HM_SOURCE="$MODE"

if [ "$MODE" = "ssh" ]; then
  if ! ssh-add -l >/dev/null 2>&1; then
    echo "warning: no SSH key loaded in the agent — 'ssh' mode needs passwordless"
    echo "         access to ${HM_SSH_HOST:-your SSH host — set HM_SSH_HOST in .env}. Try: ssh-add ~/.ssh/id_ed25519"
  fi
fi

echo "starting Hakusan Monitor (source=$MODE) ..."
exec python3 backend/server.py
