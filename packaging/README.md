# Windows packaging

Builds `dist/Prompt2Print-Setup-<version>.msi` on Linux. Installing it puts Prompt2Print in
`C:\Program Files\Prompt2Print` and adds Start Menu and Desktop shortcuts. The shortcut runs
`Prompt2Print.exe`.

```
scripts/build-windows.sh
```

One-time tools (Ubuntu): `sudo apt-get install -y wixl msitools gcc-mingw-w64-x86-64 binutils-mingw-w64-x86-64 python3-pil`
plus Node.js/npm (used only to download the official Windows `node.exe` from the npm registry
package `node-win-x64`; it is cached in `.cache/windows`).

## What gets installed

```
C:\Program Files\Prompt2Print\
  Prompt2Print.exe        launcher (packaging/launcher/launcher.c)
  runtime\node.exe        official, signed Node.js runtime (unchanged)
  runtime\NODE-LICENSE.txt
  app\server\  app\public\  app\package.json  app\README.md
```

Everything the app writes goes to `%LOCALAPPDATA%\Prompt2Print`:

```
data\      database, private model files, G-code   (P2P_DATA_DIR)
logs\      server.log, server.previous.log, launcher.log
window\    browser profile of the app window (keeps logins and settings)
```

Uninstalling removes Program Files and the shortcuts and keeps `%LOCALAPPDATA%\Prompt2Print`,
so reinstalling or upgrading keeps the shop's data.

## What Prompt2Print.exe does

1. Allows one running copy (named mutex). Starting it again just opens another window.
2. Picks a port: 39390–39393 if free (a stable port keeps the window's logins), else any free port.
3. Starts `runtime\node.exe app\server\index.js` hidden, with
   `P2P_DATA_DIR`, `P2P_PORT`, `P2P_HOST=127.0.0.1`, `P2P_DESKTOP=1`, `NODE_ENV=production`.
   The server lives in a Job Object, so Windows stops it if the launcher ends for any reason.
4. Waits up to 40 s for `GET /api/health` to answer 200, otherwise shows where the log is.
5. Opens the store in its own window: Microsoft Edge (or Chrome) in `--app` mode with its own
   profile. If neither browser exists it opens the default browser and shows a
   "Click OK to stop" dialog.
6. When the last window closes, stops the server and exits. If the server crashes it is
   restarted up to 3 times.

## Upgrades

`UpgradeCode` in `wix/Prompt2Print.wxs` must never change. Bump `version` in `package.json`
and rebuild: installing the new MSI replaces the old version (MajorUpgrade).

## Testing

`packaging/test/smoke-wine.sh dist/Prompt2Print-Setup-<version>.msi` installs the MSI in Wine,
starts the launcher with a fake Edge (`test/fake_edge.c`), checks the server health, the
`--app` window, normal close, browser hand-off, server shutdown and uninstall.

## Known limits

- The MSI is about 36 MB because `node.exe` is 94 MB (MSZIP-compressed by wixl; LZX is not
  available on Linux). It cannot be made smaller without altering `node.exe`.
- The installer has no wizard pages (wixl does not build dialogs): double-click, approve the
  Windows admin prompt, and it installs.
- The MSI and launcher are not code-signed, so Windows SmartScreen shows
  "Windows protected your PC" the first time: choose **More info → Run anyway**.
  Signing needs a code-signing certificate (e.g. `osslsigncode` on Linux).
