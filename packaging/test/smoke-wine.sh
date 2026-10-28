#!/usr/bin/env bash
# Smoke test for the Windows installer and launcher under Wine (Linux).
# Needs: wine64 (/usr/lib/wine), Xvfb, and a built MSI.
#   sudo apt-get install -y --no-install-recommends wine64 xvfb
#   packaging/test/smoke-wine.sh dist/Prompt2Print-Setup-2.0.0.msi [previous.msi]
# Checks: silent install, shortcuts, the launcher opens Edge in --app mode on the bundled
# file:///…/app/index.html (with a fake Edge), launcher exits 0, upgrade over an older MSI
# replaces it (when a previous MSI is given), uninstall removes everything.
set -euo pipefail
MSI="$(realpath "${1:?usage: smoke-wine.sh <msi> [previous-msi]}")"
PREV="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
export PATH=/usr/lib/wine:$PATH WINEPREFIX="$WORK/prefix" WINEARCH=win64 WINEDEBUG=-all
Xvfb :91 -screen 0 1280x800x24 >/dev/null 2>&1 & XPID=$!
export DISPLAY=:91
trap 'wineserver -k 2>/dev/null || true; kill $XPID 2>/dev/null || true; rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*"; exit 1; }

wine64 wineboot --init >/dev/null 2>&1 || true
APP="$WINEPREFIX/drive_c/Program Files/Prompt2Print"
if [ -n "$PREV" ]; then
  cp "$(realpath "$PREV")" "$WINEPREFIX/drive_c/prev.msi"
  wine64 msiexec /i 'C:\prev.msi' /qn >/dev/null 2>&1 || fail "install previous version"
  [ -f "$APP/Prompt2Print.exe" ] || fail "previous version files"
  echo "ok: previous version installed"
fi
cp "$MSI" "$WINEPREFIX/drive_c/p2p.msi"
wine64 msiexec /i 'C:\p2p.msi' /qn >/dev/null 2>&1 || fail "install"
[ -f "$APP/Prompt2Print.exe" ] && [ -f "$APP/app/index.html" ] && [ -f "$APP/app/app.js" ] || fail "installed files"
[ ! -e "$APP/runtime" ] && [ ! -e "$APP/app/server" ] || fail "old server files were not removed by the upgrade"
[ "$(find "$WINEPREFIX/drive_c" -iname 'Prompt2Print*.lnk' | wc -l)" -ge 2 ] || fail "shortcuts"
n_products="$(wine64 reg query 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' /s /f Prompt2Print /d 2>/dev/null | grep -c 'DisplayName' || true)"
[ "${n_products:-0}" -le 1 ] || fail "more than one Prompt2Print entry in Programs and Features ($n_products)"
echo "ok: installed with shortcuts"

x86_64-w64-mingw32-gcc -O2 -municode -mwindows -static "$HERE/fake_edge.c" -o "$WORK/msedge.exe"
EDGE="$WINEPREFIX/drive_c/Program Files (x86)/Microsoft/Edge/Application"
mkdir -p "$EDGE" && cp "$WORK/msedge.exe" "$EDGE/"
WINUSER="$(find "$WINEPREFIX/drive_c/users" -maxdepth 1 -mindepth 1 -not -name Public -printf '%f\n' | head -1)"
LOCAL="$WINEPREFIX/drive_c/users/$WINUSER/AppData/Local/Prompt2Print"

start=$(date +%s)
FAKE_EDGE_SECONDS=2 timeout 60 wine64 'C:\Program Files\Prompt2Print\Prompt2Print.exe' >/dev/null 2>&1 || fail "launcher exit code $?"
for _ in $(seq 1 20); do [ -f "$LOCAL/window/args.txt" ] && break; sleep 1; done
[ -f "$LOCAL/window/args.txt" ] || fail "fake Edge was not started (see $LOCAL/logs/launcher.log)"
grep -q -- '--app=file:///C:/Program%20Files/Prompt2Print/app/index.html' "$LOCAL/window/args.txt" || { cat "$LOCAL/window/args.txt"; fail "app window not opened on the bundled index.html"; }
grep -q -- "--user-data-dir=" "$LOCAL/window/args.txt" || fail "no dedicated browser profile"
echo "ok: app window opened on file:///…/app/index.html ($(( $(date +%s) - start ))s)"

wine64 msiexec /x 'C:\p2p.msi' /qn >/dev/null 2>&1 || fail "uninstall"
[ ! -e "$APP/Prompt2Print.exe" ] && [ ! -e "$APP/app/app.js" ] || fail "files left after uninstall"
echo "ok: uninstalled"
echo "PASS"
