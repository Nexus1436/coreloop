#!/usr/bin/env bash
set -euo pipefail

if [ ! -f dist/index.cjs ]; then
  npm run build
fi

exec npm run start
