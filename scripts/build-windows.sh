#!/usr/bin/env bash
# Builds the Windows installer: dist/Prompt2Print-Setup-<version>.msi
#
# Runs on Linux (tested on Ubuntu 24.04). One-time setup:
#   sudo apt-get install -y wixl msitools gcc-mingw-w64-x86-64 binutils-mingw-w64-x86-64 python3-pil
#   npm install            (esbuild bundles the app)
#
# Usage:
#   scripts/build-windows.sh            build and verify
#   scripts/build-windows.sh --no-verify
#
# Environment overrides:
#   P2P_DIST_DIR       output folder (default: dist)
#   P2P_SIGN_PFX / P2P_SIGN_PASS / P2P_SIGN_TS   code signing (see below)
#
# Installed layout (C:\Program Files\Prompt2Print):
#   Prompt2Print.exe   launcher: opens the app window (Edge/Chrome in app mode)
#   app\               the bundled web app (index.html, app.js, viewer.js, app.css, fonts\, img\)
# There is no server and no runtime: the app talks to the Prompt2Print cloud directly.
# Settings and the sign-in live in %LOCALAPPDATA%\Prompt2Print\window (the app window's profile).
#
# Every build gets a unique, increasing MSI version (<major>.<minor>.<build>) so that installing a
# new build over an old one always replaces it (MajorUpgrade). The build number is kept in
# packaging/build-number.txt.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
need node "Node.js (https://nodejs.org)"
python3 -c 'import PIL' 2>/dev/null || die "Python Pillow is missing — install: sudo apt-get install -y python3-pil"

# ---------------------------------------------------------------- version
APP_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version","2.0.0"))' "$ROOT/package.json")"
APP_VERSION="$(printf '%s' "$APP_VERSION" | sed -E 's/^v//; s/[-+].*$//')"
[[ "$APP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "package.json version '$APP_VERSION' is not x.y.z"
IFS=. read -r VMAJ VMIN VPAT <<< "$APP_VERSION"
BUILD_FILE="$ROOT/packaging/build-number.txt"
BUILD_NO="$(( $(cat "$BUILD_FILE" 2>/dev/null || echo 0) + 1 ))"
(( BUILD_NO <= 65535 )) || die "build number $BUILD_NO exceeds the MSI limit"
echo "$BUILD_NO" > "$BUILD_FILE"
# MSI ProductVersion: major.minor.build — patch is folded into the build number so it stays increasing.
MSI_VERSION="$VMAJ.$VMIN.$BUILD_NO"
(( VMAJ < 256 && VMIN < 256 )) || die "version $APP_VERSION is outside the MSI limits (255.255.65535)"
echo "Prompt2Print $APP_VERSION (MSI version $MSI_VERSION, build $BUILD_NO)"

# ---------------------------------------------------------------- app bundle
step "Bundling the app (esbuild)"
[ -d "$ROOT/node_modules/esbuild" ] || die "node_modules missing — run: npm install"
(cd "$ROOT" && node scripts/build-app.mjs)
[ -s "$ROOT/app-dist/index.html" ] && [ -s "$ROOT/app-dist/app.js" ] || die "app-dist was not built"

# ---------------------------------------------------------------- icon + launcher
step "Drawing the icon"
python3 "$ROOT/packaging/icon/make_icon.py"

step "Compiling Prompt2Print.exe"
mkdir -p "$BUILD"
(
  cd "$ROOT/packaging/launcher"
  x86_64-w64-mingw32-windres \
    -DP2P_VER_MAJOR="$VMAJ" -DP2P_VER_MINOR="$VMIN" -DP2P_VER_PATCH="$BUILD_NO" "-DP2P_VER_STR=\\\"$APP_VERSION.$BUILD_NO\\\"" \
    launcher.rc -O coff -o "$BUILD/launcher.res.o"
  x86_64-w64-mingw32-gcc -O2 -s -Wall -Wextra -municode -mwindows -static \
    launcher.c "$BUILD/launcher.res.o" -o "$BUILD/Prompt2Print.exe" \
    -lshell32 -ladvapi32 -luser32
)

# ---------------------------------------------------------------- staging
step "Staging files"
rm -rf "$DIST/staging"
mkdir -p "$STAGE/app"
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
  osslsigncode sign -pkcs12 "$P2P_SIGN_PFX" -pass "${P2P_SIGN_PASS:-}" -n "Prompt2Print" -i "https://bdy612.github.io/Prompt2Print/" \
    -t "${P2P_SIGN_TS:-http://timestamp.digicert.com}" -h sha256 -in "$f" -out "$f.signed" >/dev/null \
    && mv "$f.signed" "$f" && echo "signed $(basename "$f")"
}
sign_file "$STAGE/Prompt2Print.exe"
cp -r "$ROOT/app-dist/." "$STAGE/app/"
[ -e "$ROOT/THIRD_PARTY_NOTICES.md" ] && cp "$ROOT/THIRD_PARTY_NOTICES.md" "$STAGE/app/"
FILE_COUNT="$(find "$STAGE" -type f | wc -l)"
echo "$FILE_COUNT files staged"

# ---------------------------------------------------------------- installer
step "Building the MSI"
(cd "$STAGE" && find app -type f | LC_ALL=C sort) |
  wixl-heat -p "" --component-group AppFiles --var var.SourceDir --directory-ref INSTALLDIR --win64 \
  > "$BUILD/files.wxs"
MSI="$DIST/Prompt2Print-Setup-$APP_VERSION.msi"
rm -f "$MSI"
wixl -a x64 \
  -D Version="$MSI_VERSION" \
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
  msiinfo export "$MSI" Property | grep -q "ProductVersion	$MSI_VERSION" || die "ProductVersion is not $MSI_VERSION"
  check="$(mktemp -d)"
  msiextract -C "$check" "$MSI" >/dev/null
  extracted_root="$(dirname "$(find "$check" -type f -name Prompt2Print.exe | head -1)")"
  [ -n "$extracted_root" ] || die "Prompt2Print.exe is not inside the MSI"
  diff <(cd "$STAGE" && find . -type f | LC_ALL=C sort) <(cd "$extracted_root" && find . -type f | LC_ALL=C sort) \
    || die "the MSI file list does not match the staging folder"
  cmp -s "$STAGE/app/app.js" "$extracted_root/app/app.js" || die "app.js changed inside the MSI"
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
printf '\nBuilt %s (%s MB, MSI version %s)\n' "$MSI" "$(python3 -c "print(round($SIZE_BYTES/1048576, 1))")" "$MSI_VERSION"
