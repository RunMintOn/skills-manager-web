#!/usr/bin/env bash
set -euo pipefail

PORT="${SKILLS_MANAGER_PORT:-8787}"
URL="http://127.0.0.1:${PORT}/api/init"

# Starting the same local service twice is safe. Reuse the healthy instance.
if command -v curl >/dev/null 2>&1 && curl --silent --show-error --fail --max-time 3 "$URL" >/dev/null 2>&1; then
  echo "Skill Vault Manager already running at http://127.0.0.1:${PORT}"
  exit 0
fi

# Do not hide a collision with an unrelated process.
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk -v port=":${PORT}" '$4 ~ port "$" { found=1 } END { exit found ? 0 : 1 }'; then
  echo "Port ${PORT} is occupied by another process. Stop it or set SKILLS_MANAGER_PORT." >&2
  exit 1
fi

exec node src/server/server.ts
