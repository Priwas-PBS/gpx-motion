#!/bin/zsh
cd -- "$(dirname -- "$0")" || exit 1

if [[ ! -f "app/server.py" ]]; then
  osascript -e 'display alert "GPX Motion is incomplete" message "The app folder or server.py is missing. Copy the complete GPX_Motion folder and try again." as critical'
  exit 1
fi

PYTHON_BIN="$(command -v python3)"
if [[ -z "$PYTHON_BIN" ]]; then
  osascript -e 'display alert "Python 3 was not found" message "Install Python 3 and start GPX Motion again." as critical'
  exit 1
fi

exec "$PYTHON_BIN" app/server.py
