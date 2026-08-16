#!/usr/bin/env sh
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "LVOVD needs Node.js 22 or newer before it can start."
  echo "Install the current Node.js LTS release, then run this launcher again."
  exit 1
fi

exec node scripts/launch.js
