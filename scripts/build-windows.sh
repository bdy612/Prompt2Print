#!/usr/bin/env bash
# Builds the Windows installer: dist/Prompt2Print-Setup-<version>.msi
#
# Runs on Linux (tested on Ubuntu 24.04). One-time setup:
#   sudo apt-get install -y wixl msitools gcc-mingw-w64-x86-64 binutils-mingw-w64-x86-64 python3-pil
#   (plus Node.js/npm, used only to download the official Windows node.exe from the npm registry)
#
# Usage:
#   scripts/build-windows.sh            build and verify
#   scripts/build-windows.sh --no-verify
#
# Environment overrides:
#   P2P_NODE_VERSION   Windows Node.js runtime to bundle (default 24.22.1)
#   P2P_BUILD_CACHE    where the downloaded runtime is cached (default .cache/windows)
#   P2P_APP_SRC        folder that holds server/ and public/ (default: the project root)
#   P2P_DIST_DIR       output folder (default: dist)
#
# Installed layout (C:\Program Files\Prompt2Print):
#   Prompt2Print.exe   launcher: starts the server hidden and opens the app window
#   runtime\node.exe   official, signed Node.js runtime
#   app\               server/, public/, package.json, README.md, licence files
# User data is written to %LOCALAPPDATA%\Prompt2Print, never to Program Files.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_SRC="${P2P_APP_SRC:-$ROOT}"
NODE_VERSION="${P2P_NODE_VERSION:-24.22.1}"
CACHE="${P2P_BUILD_CACHE:-$ROOT/.cache/windows}"
DIST="${P2P_DIST_DIR:-$ROOT/dist}"
BUILD="$DIST/build"
STAGE="$DIST/staging/Prompt2Print"
VERIFY=1
[ "${1:-}" = "--no-verify" ] && VERIFY=0

step() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing tool '$1' — install: $2"; }

need wixl "sudo apt-get install -y wixl"
need wixl-heat "sudo apt-get install -y wixl"
need msiinfo "sudo apt-get install -y msitools"
need x86_64-w64-mingw32-gcc "sudo apt-get install -y gcc-mingw-w64-x86-64"
need x86_64-w64-mingw32-windres "sudo apt-get install -y binutils-mingw-w64-x86-64"
need python3 "sudo apt-get install -y python3 python3-pil"
need npm "Node.js (https://nodejs.org)"
python3 -c 'import PIL' 2>/dev/null || die "Python Pillow is missing — install: sudo apt-get install -y python3-pil"
[ -f "$APP_SRC/server/index.js" ] || die "$APP_SRC/server/index.js not found — the app must exist before packaging"

# ---------------------------------------------------------------- version
VERSION_RAW="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version","1.0.0"))' "$APP_SRC/package.json" 2>/dev/null || echo 1.0.0)"
VERSION="$(printf '%s' "$VERSION_RAW" | sed -E 's/^v//; s/[-+].*$//')"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || VERSION="1.0.0"
IFS=. read -r VMAJ VMIN VPAT <<< "$VERSION"
(( VMAJ < 256 && VMIN < 256 && VPAT < 65536 )) || die "version $VERSION is outside the MSI limits (255.255.65535)"
echo "Prompt2Print $VERSION, bundling Node.js $NODE_VERSION"

# ---------------------------------------------------------------- Node.js runtime
NODE_DIR="$CACHE/node-$NODE_VERSION"
if [ ! -s "$NODE_DIR/node.exe" ]; then
  step "Downloading Node.js $NODE_VERSION for Windows (npm package node-win-x64)"
  tmp="$(mktemp -d)"
  (cd "$tmp" && npm pack "node-win-x64@$NODE_VERSION" --silent >/dev/null)
  tar xzf "$tmp"/node-win-x64-*.tgz -C "$tmp"
  mkdir -p "$NODE_DIR"
  mv "$tmp/package/bin/node.exe" "$NODE_DIR/node.exe"
  rm -rf "$tmp"
fi
if [ ! -s "$NODE_DIR/LICENSE" ]; then
  step "Fetching the Node.js licence"
  if ! curl -fsSL "https://raw.githubusercontent.com/nodejs/node/v$NODE_VERSION/LICENSE" -o "$NODE_DIR/LICENSE"; then
    tmp="$(mktemp -d)"
    (cd "$tmp" && npm pack "node-linux-x64@$NODE_VERSION" --silent >/dev/null)
    tar xzf "$tmp"/node-linux-x64-*.tgz -C "$tmp" package/LICENSE
    mv "$tmp/package/LICENSE" "$NODE_DIR/LICENSE"
    rm -rf "$tmp"
  fi
fi
python3 - "$NODE_DIR/node.exe" <<'PY' || die "node.exe is not a 64-bit Windows executable"
import struct, sys
d = open(sys.argv[1], 'rb').read(4096)
pe = struct.unpack_from('<I', d, 0x3c)[0]
assert d[:2] == b'MZ' and d[pe:pe+4] == b'PE\0\0' and struct.unpack_from('<H', d, pe + 4)[0] == 0x8664
PY

# ---------------------------------------------------------------- icon + launcher
step "Drawing the icon"
python3 "$ROOT/packaging/icon/make_icon.py"

step "Compiling Prompt2Print.exe"
mkdir -p "$BUILD"
(
  cd "$ROOT/packaging/launcher"
  x86_64-w64-mingw32-windres \
    -DP2P_VER_MAJOR="$VMAJ" -DP2P_VER_MINOR="$VMIN" -DP2P_VER_PATCH="$VPAT" "-DP2P_VER_STR=\\\"$VERSION\\\"" \
    launcher.rc -O coff -o "$BUILD/launcher.res.o"
  x86_64-w64-mingw32-gcc -O2 -s -Wall -Wextra -municode -mwindows -static \
    launcher.c "$BUILD/launcher.res.o" -o "$BUILD/Prompt2Print.exe" \
    -lws2_32 -lshell32 -ladvapi32 -luser32
)

# ---------------------------------------------------------------- staging
step "Staging files"
rm -rf "$DIST/staging"
mkdir -p "$STAGE/runtime" "$STAGE/app"
cp "$BUILD/Prompt2Print.exe" "$STAGE/Prompt2Print.exe"

# ---------------------------------------------------------------- code signing (optional)
# Windows shows "Windows protected your PC" for unsigned installers. Once you have a code-signing
# certificate, export it as a .pfx and set:
#   P2P_SIGN_PFX=/path/to/cert.pfx   P2P_SIGN_PASS=<password>   [P2P_SIGN_TS=http://timestamp.digicert.com]
# Both Prompt2Print.exe and the .msi are then signed with osslsigncode (sudo apt-get install -y osslsigncode).
sign_file() {
  [ -n "${P2P_SIGN_PFX:-}" ] || return 0
  command -v osslsigncode >/dev/null || die "osslsigncode is not installed (sudo apt-get install -y osslsigncode)"
  local f="$1"
  osslsigncode sign -pkcs12 "$P2P_SIGN_PFX" -pass "${P2P_SIGN_PASS:-}" -n "Prompt2Print" -i "https://prompt2print.app" \
    -t "${P2P_SIGN_TS:-http://timestamp.digicert.com}" -h sha256 -in "$f" -out "$f.signed" >/dev/null \
    && mv "$f.signed" "$f" && echo "signed $(basename "$f")"
}
sign_file "$STAGE/Prompt2Print.exe"
cp "$NODE_DIR/node.exe" "$STAGE/runtime/node.exe"
cp "$NODE_DIR/LICENSE" "$STAGE/runtime/NODE-LICENSE.txt"
items=()
for item in server public package.json THIRD_PARTY_NOTICES.md LICENSE LICENSE.md LICENSE.txt; do
  [ -e "$APP_SRC/$item" ] && items+=("$item")
done
tar -C "$APP_SRC" \
  --exclude='node_modules' --exclude='.env' --exclude='.env.*' --exclude='*.log' \
  --exclude='.DS_Store' --exclude='Thumbs.db' --exclude='*.db' --exclude='*.db-*' \
  -cf - "${items[@]}" | tar -C "$STAGE/app" -xf -
# Optional: ship API keys with the installer (P2P_BUNDLE_ENV=/path/to/.env). They are moved into
# the encrypted vault on first start.
if [ -n "${P2P_BUNDLE_ENV:-}" ] && [ -f "$P2P_BUNDLE_ENV" ]; then
  cp "$P2P_BUNDLE_ENV" "$STAGE/app/.env"
  echo "bundled keys from $P2P_BUNDLE_ENV"
fi
FILE_COUNT="$(find "$STAGE" -type f | wc -l)"
echo "$FILE_COUNT files staged"

# ---------------------------------------------------------------- installer
step "Building the MSI"
(cd "$STAGE" && find app runtime -type f | LC_ALL=C sort) |
  wixl-heat -p "" --component-group AppFiles --var var.SourceDir --directory-ref INSTALLDIR --win64 \
  > "$BUILD/files.wxs"
MSI="$DIST/Prompt2Print-Setup-$VERSION.msi"
rm -f "$MSI"
wixl -a x64 \
  -D Version="$VERSION" \
  -D SourceDir="$STAGE" \
  -D IconFile="$ROOT/packaging/icon/prompt2print.ico" \
  -D Win64=yes \
  -o "$MSI" "$ROOT/packaging/wix/Prompt2Print.wxs" "$BUILD/files.wxs"
[ -s "$MSI" ] || die "wixl did not produce $MSI"
sign_file "$MSI"

# ---------------------------------------------------------------- verification
if [ "$VERIFY" = 1 ]; then
  step "Verifying"
  msiinfo suminfo "$MSI" | grep -E 'Subject|Template|Version' || true
  for t in File Component Shortcut Upgrade Media; do
    msiinfo export "$MSI" "$t" >/dev/null || die "MSI table $t is missing"
  done
  check="$(mktemp -d)"
  msiextract -C "$check" "$MSI" >/dev/null
  extracted_root="$(dirname "$(find "$check" -type f -name Prompt2Print.exe | head -1)")"
  [ -n "$extracted_root" ] || die "Prompt2Print.exe is not inside the MSI"
  diff <(cd "$STAGE" && find . -type f | LC_ALL=C sort) <(cd "$extracted_root" && find . -type f | LC_ALL=C sort) \
    || die "the MSI file list does not match the staging folder"
  cmp -s "$STAGE/runtime/node.exe" "$extracted_root/runtime/node.exe" || die "node.exe changed inside the MSI"
  rm -rf "$check"
  python3 - "$STAGE/Prompt2Print.exe" <<'PY' || die "launcher PE check failed"
import struct, sys
d = open(sys.argv[1], 'rb').read()
pe = struct.unpack_from('<I', d, 0x3c)[0]
assert d[pe:pe+4] == b'PE\0\0', 'not a PE file'
assert struct.unpack_from('<H', d, pe + 4)[0] == 0x8664, 'not x64'
assert struct.unpack_from('<H', d, pe + 24 + 68)[0] == 2, 'not a GUI-subsystem exe'
assert b'.rsrc' in d[:4096], 'no resource section'
print('launcher: x64, GUI subsystem, resources embedded')
PY
  echo "MSI contents match the staging folder ($FILE_COUNT files)"
fi

SIZE_BYTES="$(stat -c %s "$MSI")"
printf '\nBuilt %s (%s MB)\n' "$MSI" "$(python3 -c "print(round($SIZE_BYTES/1048576, 1))")"
