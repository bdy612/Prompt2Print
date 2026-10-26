#!/usr/bin/env bash
# Smoke test for the Windows installer and launcher under Wine (Linux).
# Needs: wine64 (/usr/lib/wine), Xvfb, curl, and a built MSI.
#   sudo apt-get install -y --no-install-recommends wine64 xvfb curl
#   packaging/test/smoke-wine.sh dist/Prompt2Print-Setup-1.0.0.msi
# Checks: silent install, shortcuts, server start + /api/health, app window launch with a fake
# Edge (normal close and hand-off), server stops when the window closes, uninstall.
set -euo pipefail
MSI="$(realpath "${1:?usage: smoke-wine.sh <msi>}")"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
export PATH=/usr/lib/wine:$PATH WINEPREFIX="$WORK/prefix" WINEARCH=win64 WINEDEBUG=-all
Xvfb :91 -screen 0 1280x800x24 >/dev/null 2>&1 & XPID=$!
export DISPLAY=:91
trap 'wineserver -k 2>/dev/null || true; kill $XPID 2>/dev/null || true; rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*"; exit 1; }

wine64 wineboot --init >/dev/null 2>&1 || true
cp "$MSI" "$WINEPREFIX/drive_c/p2p.msi"
wine64 msiexec /i 'C:\p2p.msi' /qn >/dev/null 2>&1 || fail "install"
APP="$WINEPREFIX/drive_c/Program Files/Prompt2Print"
[ -f "$APP/Prompt2Print.exe" ] && [ -f "$APP/runtime/node.exe" ] && [ -f "$APP/app/server/index.js" ] || fail "installed files"
[ "$(find "$WINEPREFIX/drive_c" -iname 'Prompt2Print*.lnk' | wc -l)" -ge 2 ] || fail "shortcuts"
echo "ok: installed with shortcuts"

x86_64-w64-mingw32-gcc -O2 -municode -mwindows -static "$HERE/fake_edge.c" -o "$WORK/msedge.exe"
EDGE="$WINEPREFIX/drive_c/Program Files (x86)/Microsoft/Edge/Application"
mkdir -p "$EDGE" && cp "$WORK/msedge.exe" "$EDGE/"
WINUSER="$(find "$WINEPREFIX/drive_c/users" -maxdepth 1 -mindepth 1 -not -name Public -printf '%f\n' | head -1)"
LOCAL="$WINEPREFIX/drive_c/users/$WINUSER/AppData/Local/Prompt2Print"

run() {  # $1 = label, env FAKE_EDGE_* set by caller
  local start; start=$(date +%s)
  ( timeout 90 wine64 'C:\Program Files\Prompt2Print\Prompt2Print.exe' >/dev/null 2>&1; echo $? > "$WORK/exit" ) &
  local lpid=$!
  local up=0
  for _ in $(seq 1 40); do
    port=$(cat "$LOCAL/data/launcher.port" 2>/dev/null || true)
    if [ -n "$port" ] && curl -fs -m 1 "http://127.0.0.1:$port/api/health" >/dev/null; then up=1; break; fi
    sleep 1
  done
  [ $up = 1 ] || fail "$1: server never became healthy (see $LOCAL/logs)"
  wait "$lpid"
  [ "$(cat "$WORK/exit")" = 0 ] || fail "$1: launcher exit code $(cat "$WORK/exit")"
  curl -fs -m 1 "http://127.0.0.1:$port/api/health" >/dev/null && fail "$1: server still running after the window closed"
  grep -q -- "--app=http://127.0.0.1:$port/" "$LOCAL/window/args.txt" || fail "$1: app window not opened with --app"
  echo "ok: $1 (port $port, $(( $(date +%s) - start ))s)"
  rm -f "$LOCAL/window/args.txt"
}
FAKE_EDGE_SECONDS=6 run "app window open then closed"
FAKE_EDGE_SECONDS=6 FAKE_EDGE_HANDOFF=1 run "browser hand-off"

wine64 msiexec /x 'C:\p2p.msi' /qn >/dev/null 2>&1 || fail "uninstall"
[ ! -e "$APP/Prompt2Print.exe" ] || fail "files left after uninstall"
echo "ok: uninstalled"
echo "PASS"
