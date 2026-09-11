#!/bin/sh
cd -- "$(dirname -- "$0")" || exit 1

if [ ! -f "app/server.py" ]; then
  printf '%s\n' "GPX Motion cannot find app/server.py. Copy the complete GPX_Motion folder and try again."
  exit 1
fi

PYTHON_BIN="$(command -v python3)"
if [ -z "$PYTHON_BIN" ]; then
  printf '%s\n' "Python 3 was not found. Install Python 3 and start GPX Motion again."
  exit 1
fi

exec "$PYTHON_BIN" app/server.py
