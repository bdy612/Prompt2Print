/*
 * Prompt2Print.exe — Windows launcher.
 *
 * Opens the Prompt2Print app (a static web app bundled next to this exe) in its own window:
 * Microsoft Edge or Google Chrome in --app mode with a dedicated profile. There is no server:
 * the app talks to the Prompt2Print cloud (Supabase) directly.
 *
 * Installed layout (next to this exe):
 *   app\index.html, app\app.js, app\viewer.js, app\app.css, app\fonts\, app\img\
 * Writable data lives in %LOCALAPPDATA%\Prompt2Print:
 *   window\                 the app window's browser profile (keeps your sign-in and cart)
 *   logs\launcher.log       launcher diagnostics
 *
 * Build (see scripts/build-windows.sh):
 *   x86_64-w64-mingw32-windres launcher.rc -O coff -o launcher.res.o
 *   x86_64-w64-mingw32-gcc -O2 -s -municode -mwindows -static launcher.c launcher.res.o \
 *       -o Prompt2Print.exe -lshell32 -ladvapi32 -luser32
 */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdarg.h>
#include <wchar.h>

#define APP_NAME L"Prompt2Print"

static wchar_t g_exeDir[MAX_PATH];
static wchar_t g_baseDir[MAX_PATH];   /* %LOCALAPPDATA%\Prompt2Print */
static wchar_t g_logsDir[MAX_PATH];
static wchar_t g_windowDir[MAX_PATH];
static wchar_t g_launcherLog[MAX_PATH];
static wchar_t g_indexHtml[MAX_PATH];

/* ---------- small helpers ---------- */

static void logMsg(const wchar_t *fmt, ...) {
    if (!g_launcherLog[0]) return;
    wchar_t line[2048];
    SYSTEMTIME st;
    GetLocalTime(&st);
    int n = _snwprintf(line, 2047, L"%04u-%02u-%02u %02u:%02u:%02u ", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    va_list ap;
    va_start(ap, fmt);
    n += _vsnwprintf(line + n, 2047 - n, fmt, ap);
    va_end(ap);
    if (n < 0 || n > 2045) n = 2045;
    line[n++] = L'\r'; line[n++] = L'\n'; line[n] = 0;
    FILE *f = _wfopen(g_launcherLog, L"a, ccs=UTF-8");
    if (!f) return;
    fputws(line, f);
    fclose(f);
}

static void showError(const wchar_t *fmt, ...) {
    wchar_t msg[2048];
    va_list ap;
    va_start(ap, fmt);
    _vsnwprintf(msg, 2047, fmt, ap);
    va_end(ap);
    msg[2047] = 0;
    logMsg(L"ERROR: %ls", msg);
    MessageBoxW(NULL, msg, APP_NAME, MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
}

static BOOL fileExists(const wchar_t *path) {
    DWORD a = GetFileAttributesW(path);
    return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

static void joinPath(wchar_t *out, const wchar_t *a, const wchar_t *b) {
    _snwprintf(out, MAX_PATH - 1, L"%ls\\%ls", a, b);
    out[MAX_PATH - 1] = 0;
}

static void ensureDir(const wchar_t *path) {
    wchar_t tmp[MAX_PATH];
    wcsncpy(tmp, path, MAX_PATH - 1);
    tmp[MAX_PATH - 1] = 0;
    for (wchar_t *p = tmp + 3; *p; p++) {
        if (*p == L'\\') { *p = 0; CreateDirectoryW(tmp, NULL); *p = L'\\'; }
    }
    CreateDirectoryW(tmp, NULL);
}

static BOOL initPaths(void) {
    DWORD n = GetModuleFileNameW(NULL, g_exeDir, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return FALSE;
    wchar_t *slash = wcsrchr(g_exeDir, L'\\');
    if (slash) *slash = 0;

    wchar_t local[MAX_PATH];
    DWORD len = GetEnvironmentVariableW(L"LOCALAPPDATA", local, MAX_PATH);
    if (len == 0 || len >= MAX_PATH) {
        len = GetEnvironmentVariableW(L"USERPROFILE", local, MAX_PATH);
        if (len == 0 || len >= MAX_PATH) return FALSE;
        wcsncat(local, L"\\AppData\\Local", MAX_PATH - wcslen(local) - 1);
    }
    joinPath(g_baseDir, local, APP_NAME);
    joinPath(g_logsDir, g_baseDir, L"logs");
    joinPath(g_windowDir, g_baseDir, L"window");
    joinPath(g_launcherLog, g_logsDir, L"launcher.log");
    joinPath(g_indexHtml, g_exeDir, L"app\\index.html");
    ensureDir(g_logsDir);
    ensureDir(g_windowDir);
    return TRUE;
}

/* C:\Program Files\Prompt2Print\app\index.html -> file:///C:/Program%20Files/Prompt2Print/app/index.html */
static void fileUrl(const wchar_t *path, wchar_t *out, size_t cap) {
    size_t n = 0;
    const wchar_t *prefix = L"file:///";
    while (*prefix && n < cap - 1) out[n++] = *prefix++;
    for (const wchar_t *p = path; *p && n < cap - 8; p++) {
        wchar_t c = *p;
        if (c == L'\\') out[n++] = L'/';
        else if (c == L' ') { out[n++] = L'%'; out[n++] = L'2'; out[n++] = L'0'; }
        else if (c == L'#') { out[n++] = L'%'; out[n++] = L'2'; out[n++] = L'3'; }
        else if (c == L'%') { out[n++] = L'%'; out[n++] = L'2'; out[n++] = L'5'; }
        else out[n++] = c;
    }
    out[n] = 0;
}

/* ---------- browsers ---------- */

static BOOL regAppPath(HKEY root, const wchar_t *exe, DWORD extraFlags, wchar_t *out) {
    wchar_t key[256];
    _snwprintf(key, 255, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\%ls", exe);
    key[255] = 0;
    DWORD size = MAX_PATH * sizeof(wchar_t);
    if (RegGetValueW(root, key, NULL, RRF_RT_REG_SZ | extraFlags, NULL, out, &size) != ERROR_SUCCESS) return FALSE;
    if (out[0] == L'"') {
        size_t n = wcslen(out);
        memmove(out, out + 1, n * sizeof(wchar_t));
        wchar_t *q = wcschr(out, L'"');
        if (q) *q = 0;
    }
    return fileExists(out);
}

static BOOL envPath(const wchar_t *var, const wchar_t *rest, wchar_t *out) {
    wchar_t base[MAX_PATH];
    DWORD n = GetEnvironmentVariableW(var, base, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return FALSE;
    joinPath(out, base, rest);
    return fileExists(out);
}

static BOOL findBrowser(const wchar_t *exe, const wchar_t *relPath, wchar_t *out) {
    if (regAppPath(HKEY_LOCAL_MACHINE, exe, 0, out)) return TRUE;
    if (regAppPath(HKEY_LOCAL_MACHINE, exe, RRF_SUBKEY_WOW6432KEY, out)) return TRUE;
    if (regAppPath(HKEY_CURRENT_USER, exe, 0, out)) return TRUE;
    if (envPath(L"ProgramFiles(x86)", relPath, out)) return TRUE;
    if (envPath(L"ProgramFiles", relPath, out)) return TRUE;
    if (envPath(L"ProgramW6432", relPath, out)) return TRUE;
    if (envPath(L"LOCALAPPDATA", relPath, out)) return TRUE;
    return FALSE;
}

static BOOL findAnyBrowser(wchar_t *out) {
    if (findBrowser(L"msedge.exe", L"Microsoft\\Edge\\Application\\msedge.exe", out)) return TRUE;
    if (findBrowser(L"chrome.exe", L"Google\\Chrome\\Application\\chrome.exe", out)) return TRUE;
    return FALSE;
}

/* Launches the browser as an app window on the bundled index.html. */
static BOOL openAppWindow(const wchar_t *browser, const wchar_t *url) {
    wchar_t cmd[4096];
    _snwprintf(cmd, 4095,
               L"\"%ls\" --app=%ls --user-data-dir=\"%ls\" "
               L"--no-first-run --no-default-browser-check --disable-background-mode "
               L"--hide-crash-restore-bubble --disable-sync --disable-features=msEdgeStartupBoost,msImplicitSignin "
               L"--window-size=1400,900",
               browser, url, g_windowDir);
    cmd[4095] = 0;
    STARTUPINFOW si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(browser, cmd, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
        logMsg(L"could not start %ls: %lu", browser, GetLastError());
        return FALSE;
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    logMsg(L"app window opened with %ls (pid %lu)", browser, pi.dwProcessId);
    return TRUE;
}

/* ---------- main ---------- */

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE hPrev, PWSTR cmdLine, int show) {
    (void)hInst; (void)hPrev; (void)cmdLine; (void)show;
    if (!initPaths()) {
        MessageBoxW(NULL, L"Could not find your local app data folder.", APP_NAME, MB_OK | MB_ICONERROR);
        return 1;
    }
    logMsg(L"---- launcher start (%ls)", g_exeDir);
    if (!fileExists(g_indexHtml)) {
        showError(L"Prompt2Print is not installed correctly (missing app\\index.html).\n\nPlease run the installer again.");
        return 1;
    }
    wchar_t url[2048];
    fileUrl(g_indexHtml, url, 2048);
    logMsg(L"url %ls", url);

    wchar_t browser[MAX_PATH];
    if (findAnyBrowser(browser) && openAppWindow(browser, url)) {
        logMsg(L"launcher exit (0)");
        return 0;
    }
    /* No Edge or Chrome: open with whatever the system uses for .html files. */
    logMsg(L"no Edge/Chrome found, using the default browser");
    HINSTANCE r = ShellExecuteW(NULL, L"open", g_indexHtml, NULL, NULL, SW_SHOWNORMAL);
    if ((INT_PTR)r <= 32) {
        showError(L"Could not open Prompt2Print. Please install Microsoft Edge or Google Chrome and try again.");
        return 1;
    }
    logMsg(L"launcher exit (0)");
    return 0;
}
