#!/usr/bin/env bash
set -euo pipefail

if [ ! -d "node_modules" ]; then
  npm install
fi

exec pi --extension ./extensions/openvibes/index.ts "$@"
