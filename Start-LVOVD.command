#!/bin/bash
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "LVOVD needs Node.js 22 or newer before it can start."
  echo "Install the current Node.js LTS release, then run Start-LVOVD.command again."
  echo
  read -r -p "Press Return to close..."
  exit 1
fi

node scripts/launch.js
status=$?

if [ "$status" -ne 0 ]; then
  echo
  echo "LVOVD stopped because of an error. See the message above and README.md for setup help."
  echo
  read -r -p "Press Return to close..."
fi

exit "$status"
