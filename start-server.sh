#!/usr/bin/env bash
# Noctyl server, quick start for Linux (and macOS).
#   Keeps the server's data (accounts, encrypted chats and keys) in your Noctyl folder:
#   ~/Noctyl/NoctylServerData, or the Noctyl folder you chose in the desktop app.
#   Asks who can sign in (one account or several), the port, which address to answer on (every address, only this
#   computer, or one address such as your Tailscale IP), and where Ollama runs (here, or another device: optional).
#   Skip the questions with NOCTYL_MODE (single, open or admin), NOCTYL_PORT, NOCTYL_HOST (an IP, or 0.0.0.0) and
#   NOCTYL_OLLAMA (an address, or local); NOCTYL_NO_BROWSER=1 skips opening the browser. E.g. for a systemd service
#   that only your tailnet can reach, using Ollama on your GPU desktop:
#     NOCTYL_MODE=admin NOCTYL_HOST=100.101.102.103 NOCTYL_OLLAMA=100.64.0.5 NOCTYL_NO_BROWSER=1 ./start-server.sh
#   (NOCTYL_ACCESS=local or network from earlier versions still works.)
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Noctyl needs Node.js. Install the LTS version from https://nodejs.org (or your package manager), then run this again."
  exit 1
fi
# the server's database is the SQLite built into Node 22.13 and newer
if [ "$(node -p 'const [a,b]=process.versions.node.split(".").map(Number); a>22||(a===22&&b>=13)?1:0')" != "1" ]; then
  echo "The Noctyl server needs Node.js 22.13 or newer (you have $(node -v)). Install the current LTS from https://nodejs.org."
  exit 1
fi

DATA="${NOCTYL_SERVER_DATA:-$(node server/paths.js)}"
# Ctrl+C at a question (asked by server/ask.js, which answers CANCEL) or anywhere before the server starts: stop, start nothing
cancelled() { echo; echo "  Cancelled. Nothing was started."; exit 130; }
trap cancelled INT
ask() { [ -t 0 ]; }   # someone at the keyboard (opens the browser for them)
# one question: its answer, or stop here if it was cancelled
answer() { local v; v="$(node server/ask.js "$@")" || exit 130; [ "$v" = "CANCEL" ] && exit 130; printf '%s' "$v"; }

echo
echo "  Noctyl server"
echo "  Data folder: $DATA"
echo "  Press Ctrl+C at any question to cancel."

# ---------- who can sign in ----------
MODE="$(answer mode "$DATA")" || exit 130

# ---------- port ----------
PORT="$(answer port)" || exit 130

# ---------- which address to answer on ----------
HOST="${NOCTYL_HOST:-}"
if [ -z "$HOST" ] && [ "${NOCTYL_ACCESS:-}" = "local" ]; then HOST=127.0.0.1; fi
if [ -z "$HOST" ] && [ "${NOCTYL_ACCESS:-}" = "network" ]; then HOST=0.0.0.0; fi
if [ -z "$HOST" ]; then HOST="$(answer host)" || exit 130; fi
HOST="${HOST:-0.0.0.0}"

# ---------- where Ollama runs (optional) ----------
OLLAMA="$(answer ollama "$DATA")" || exit 130
OLLAMA="${OLLAMA:-local}"

OPEN="$(node server/ask.js open "$HOST" "$PORT")"
echo
if [ "$HOST" != "127.0.0.1" ]; then echo "  Before you open it to the internet, put it behind HTTPS (on Tailscale: tailscale serve)."; fi
echo "  Open $OPEN/login to sign in. Press Ctrl+C to stop the server."
echo
# open the sign-in page once the server is up, when there's a desktop to open it on
if ask && [ -z "${NOCTYL_NO_BROWSER:-}" ]; then
  if command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then (sleep 2; xdg-open "$OPEN/login" >/dev/null 2>&1) &
  elif [ "$(uname -s)" = "Darwin" ]; then (sleep 2; open "$OPEN/login") &
  fi
fi
trap - INT   # from here Ctrl+C stops the server itself
exec node server/index.js --data "$DATA" --port "$PORT" --host "$HOST" --mode "$MODE" --ollama "$OLLAMA"
