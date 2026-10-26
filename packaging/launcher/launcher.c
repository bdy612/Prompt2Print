/*
 * Prompt2Print.exe — Windows launcher.
 *
 * Starts the bundled Node.js server hidden in the background, waits until it answers
 * GET /api/health, then opens the store in its own app window (Microsoft Edge or Chrome
 * in --app mode with a dedicated profile). When the last window closes, the server stops.
 *
 * Installed layout (next to this exe):
 *   runtime\node.exe        official Node.js runtime
 *   app\server\index.js     the Prompt2Print server
 *   app\public\...          the web interface
 * Writable data lives in %LOCALAPPDATA%\Prompt2Print (Program Files is read-only):
 *   data\                   database, private model files, G-code (P2P_DATA_DIR)
 *   logs\server.log         server output, logs\launcher.log launcher diagnostics
 *   window\                 the app window's browser profile (keeps your login and cart)
 *
 * Build (see scripts/build-windows.sh):
 *   x86_64-w64-mingw32-windres launcher.rc -O coff -o launcher.res.o
 *   x86_64-w64-mingw32-gcc -O2 -s -municode -mwindows -static launcher.c launcher.res.o \
 *       -o Prompt2Print.exe -lws2_32 -lshell32 -ladvapi32 -luser32
 */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdarg.h>
#include <wchar.h>

#define APP_NAME L"Prompt2Print"
#define MUTEX_NAME L"Local\\Prompt2Print.Launcher.v1"
#define HEALTH_TIMEOUT_MS 40000
#define MAX_RESTARTS 3

/* Preferred ports: a stable port keeps the window's origin the same between launches,
   so logins and saved settings in the app window survive a restart. */
static const unsigned short PREFERRED_PORTS[] = { 39390, 39391, 39392, 39393 };

static wchar_t g_exeDir[MAX_PATH];
static wchar_t g_baseDir[MAX_PATH];   /* %LOCALAPPDATA%\Prompt2Print */
static wchar_t g_dataDir[MAX_PATH];
static wchar_t g_logsDir[MAX_PATH];
static wchar_t g_windowDir[MAX_PATH];
static wchar_t g_portFile[MAX_PATH];
static wchar_t g_serverLog[MAX_PATH];
static wchar_t g_launcherLog[MAX_PATH];

/* ---------- small helpers ---------- */

static void logMsg(const wchar_t *fmt, ...) {
    if (!g_launcherLog[0]) return;
    wchar_t line[2048];
    SYSTEMTIME st;
    GetLocalTime(&st);
    int n = _snwprintf(line, 64, L"%04d-%02d-%02d %02d:%02d:%02d  ",
                       st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    if (n < 0) n = 0;
    va_list ap;
    va_start(ap, fmt);
    _vsnwprintf(line + n, 2040 - n, fmt, ap);
    va_end(ap);
    line[2040] = 0;
    wcscat(line, L"\r\n");
    char utf8[6200];
    int len = WideCharToMultiByte(CP_UTF8, 0, line, -1, utf8, sizeof(utf8), NULL, NULL);
    if (len <= 1) return;
    HANDLE h = CreateFileW(g_launcherLog, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                           OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    DWORD w;
    WriteFile(h, utf8, (DWORD)(len - 1), &w, NULL);
    CloseHandle(h);
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
    /* Create every missing parent, like mkdir -p. */
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
    joinPath(g_dataDir, g_baseDir, L"data");
    joinPath(g_logsDir, g_baseDir, L"logs");
    joinPath(g_windowDir, g_baseDir, L"window");
    joinPath(g_portFile, g_dataDir, L"launcher.port");
    joinPath(g_serverLog, g_logsDir, L"server.log");
    joinPath(g_launcherLog, g_logsDir, L"launcher.log");
    ensureDir(g_dataDir);
    ensureDir(g_logsDir);
    ensureDir(g_windowDir);
    return TRUE;
}

/* ---------- networking ---------- */

static BOOL portIsFree(unsigned short port, unsigned short *chosen) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return FALSE;
    BOOL yes = TRUE;
    setsockopt(s, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&yes, sizeof(yes));
    struct sockaddr_in a;
    ZeroMemory(&a, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    a.sin_port = htons(port);
    BOOL ok = bind(s, (struct sockaddr *)&a, sizeof(a)) == 0;
    if (ok && chosen) {
        int alen = sizeof(a);
        if (getsockname(s, (struct sockaddr *)&a, &alen) == 0) *chosen = ntohs(a.sin_port);
        else ok = FALSE;
    }
    closesocket(s);
    return ok;
}

static unsigned short pickPort(void) {
    unsigned short p = 0;
    for (size_t i = 0; i < sizeof(PREFERRED_PORTS) / sizeof(PREFERRED_PORTS[0]); i++) {
        if (portIsFree(PREFERRED_PORTS[i], &p)) return p;
    }
    if (portIsFree(0, &p)) return p;   /* any free port */
    return 0;
}

/* Sends GET /api/health and returns TRUE on an HTTP 200 answer. */
static BOOL healthOk(unsigned short port) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return FALSE;
    DWORD tmo = 2000;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char *)&tmo, sizeof(tmo));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char *)&tmo, sizeof(tmo));
    struct sockaddr_in a;
    ZeroMemory(&a, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    a.sin_port = htons(port);
    BOOL ok = FALSE;
    if (connect(s, (struct sockaddr *)&a, sizeof(a)) == 0) {
        const char *req = "GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
        if (send(s, req, (int)strlen(req), 0) > 0) {
            char buf[64] = { 0 };
            int got = 0, r;
            while (got < 12 && (r = recv(s, buf + got, (int)sizeof(buf) - 1 - got, 0)) > 0) got += r;
            /* "HTTP/1.1 200" */
            ok = got >= 12 && strncmp(buf, "HTTP/1.", 7) == 0 && strncmp(buf + 9, "200", 3) == 0;
        }
    }
    closesocket(s);
    return ok;
}

static BOOL writePortFile(unsigned short port) {
    HANDLE h = CreateFileW(g_portFile, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return FALSE;
    char buf[16];
    int n = snprintf(buf, sizeof(buf), "%u", (unsigned)port);
    DWORD w;
    BOOL ok = WriteFile(h, buf, (DWORD)n, &w, NULL);
    CloseHandle(h);
    return ok;
}

static unsigned short readPortFile(void) {
    HANDLE h = CreateFileW(g_portFile, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    char buf[16] = { 0 };
    DWORD r = 0;
    ReadFile(h, buf, sizeof(buf) - 1, &r, NULL);
    CloseHandle(h);
    long v = strtol(buf, NULL, 10);
    return (v > 0 && v < 65536) ? (unsigned short)v : 0;
}

/* ---------- server process ---------- */

typedef struct {
    HANDLE job;
    HANDLE process;
    unsigned short port;
} Server;

static BOOL startServer(Server *srv) {
    wchar_t node[MAX_PATH], script[MAX_PATH], appDir[MAX_PATH];
    joinPath(node, g_exeDir, L"runtime\\node.exe");
    joinPath(script, g_exeDir, L"app\\server\\index.js");
    joinPath(appDir, g_exeDir, L"app");
    if (!fileExists(node) || !fileExists(script)) {
        showError(L"Prompt2Print is missing files:\n%ls\n%ls\n\nPlease reinstall Prompt2Print.", node, script);
        return FALSE;
    }

    wchar_t portStr[16];
    _snwprintf(portStr, 15, L"%u", (unsigned)srv->port);
    portStr[15] = 0;
    SetEnvironmentVariableW(L"P2P_DATA_DIR", g_dataDir);
    SetEnvironmentVariableW(L"P2P_PORT", portStr);
    SetEnvironmentVariableW(L"P2P_HOST", L"127.0.0.1");
    SetEnvironmentVariableW(L"P2P_DESKTOP", L"1");
    SetEnvironmentVariableW(L"NODE_ENV", L"production");

    /* Keep the previous run's log next to the new one. */
    wchar_t prevLog[MAX_PATH];
    joinPath(prevLog, g_logsDir, L"server.previous.log");
    MoveFileExW(g_serverLog, prevLog, MOVEFILE_REPLACE_EXISTING);

    SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
    HANDLE logH = CreateFileW(g_serverLog, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa,
                              OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    HANDLE nulH = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, NULL);

    STARTUPINFOW si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdInput = nulH;
    si.hStdOutput = logH;
    si.hStdError = logH;

    wchar_t cmd[3 * MAX_PATH + 128];
    _snwprintf(cmd, sizeof(cmd) / sizeof(cmd[0]) - 1,
               L"\"%ls\" --disable-warning=ExperimentalWarning \"%ls\"", node, script);
    cmd[sizeof(cmd) / sizeof(cmd[0]) - 1] = 0;

    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));
    BOOL ok = CreateProcessW(node, cmd, NULL, NULL, TRUE,
                             CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                             NULL, appDir, &si, &pi);
    DWORD err = GetLastError();
    if (logH != INVALID_HANDLE_VALUE) CloseHandle(logH);
    if (nulH != INVALID_HANDLE_VALUE) CloseHandle(nulH);
    if (!ok) {
        showError(L"Could not start the Prompt2Print server (error %lu).", err);
        return FALSE;
    }
    /* The job makes Windows kill the server if the launcher ends for any reason. */
    if (!AssignProcessToJobObject(srv->job, pi.hProcess)) logMsg(L"AssignProcessToJobObject failed: %lu", GetLastError());
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    srv->process = pi.hProcess;
    logMsg(L"server started, pid %lu, port %u", pi.dwProcessId, (unsigned)srv->port);
    return TRUE;
}

static BOOL waitForHealth(Server *srv) {
    ULONGLONG start = GetTickCount64();
    while (GetTickCount64() - start < HEALTH_TIMEOUT_MS) {
        if (WaitForSingleObject(srv->process, 0) == WAIT_OBJECT_0) {
            DWORD code = 0;
            GetExitCodeProcess(srv->process, &code);
            showError(L"The Prompt2Print server stopped while starting (exit code %lu).\n\nDetails are in:\n%ls", code, g_serverLog);
            return FALSE;
        }
        if (healthOk(srv->port)) return TRUE;
        Sleep(250);
    }
    showError(L"The Prompt2Print server did not start within %d seconds.\n\nDetails are in:\n%ls", HEALTH_TIMEOUT_MS / 1000, g_serverLog);
    return FALSE;
}

/* ---------- app window ---------- */

static BOOL regAppPath(HKEY root, const wchar_t *exe, DWORD extraFlags, wchar_t *out) {
    wchar_t key[256];
    _snwprintf(key, 255, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\%ls", exe);
    key[255] = 0;
    DWORD size = MAX_PATH * sizeof(wchar_t);
    if (RegGetValueW(root, key, NULL, RRF_RT_REG_SZ | extraFlags, NULL, out, &size) != ERROR_SUCCESS) return FALSE;
    /* Some installers store the path in quotes. */
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

/* Launches the browser as an app window. Returns its process handle, or NULL. */
static HANDLE openAppWindow(const wchar_t *browser, unsigned short port) {
    wchar_t cmd[4096];
    _snwprintf(cmd, 4095,
               L"\"%ls\" --app=http://127.0.0.1:%u/ --user-data-dir=\"%ls\" "
               L"--no-first-run --no-default-browser-check --disable-background-mode "
               L"--hide-crash-restore-bubble --disable-sync --disable-features=msEdgeStartupBoost,msImplicitSignin "
               L"--window-size=1400,900",
               browser, (unsigned)port, g_windowDir);
    cmd[4095] = 0;
    STARTUPINFOW si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(browser, cmd, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
        logMsg(L"could not start %ls: %lu", browser, GetLastError());
        return NULL;
    }
    CloseHandle(pi.hThread);
    logMsg(L"app window opened with %ls (pid %lu)", browser, pi.dwProcessId);
    return pi.hProcess;
}

/* Chromium browsers hold <profile>\lockfile open (delete-on-close) while any window of
   that profile is open, even if the first process handed off to another one. */
static BOOL profileInUse(void) {
    wchar_t lock[MAX_PATH];
    joinPath(lock, g_windowDir, L"lockfile");
    return fileExists(lock);
}

static BOOL findAnyBrowser(wchar_t *out) {
    if (findBrowser(L"msedge.exe", L"Microsoft\\Edge\\Application\\msedge.exe", out)) return TRUE;
    if (findBrowser(L"chrome.exe", L"Google\\Chrome\\Application\\chrome.exe", out)) return TRUE;
    return FALSE;
}

static void openInDefaultBrowserAndWait(unsigned short port) {
    wchar_t url[64];
    _snwprintf(url, 63, L"http://127.0.0.1:%u/", (unsigned)port);
    url[63] = 0;
    ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL);
    wchar_t msg[256];
    _snwprintf(msg, 255, L"Prompt2Print is running at %ls\n\nClick OK to stop it.", url);
    msg[255] = 0;
    MessageBoxW(NULL, msg, APP_NAME, MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND);
}

/* ---------- second instance ---------- */

static int runSecondInstance(void) {
    /* The first launcher may still be starting: wait for its port and health check. */
    ULONGLONG start = GetTickCount64();
    unsigned short port = 0;
    while (GetTickCount64() - start < HEALTH_TIMEOUT_MS) {
        port = readPortFile();
        if (port && healthOk(port)) break;
        port = 0;
        Sleep(300);
    }
    if (!port) {
        showError(L"Prompt2Print is already starting but is not answering yet. Please try again in a moment.");
        return 1;
    }
    wchar_t browser[MAX_PATH];
    if (findAnyBrowser(browser)) {
        HANDLE h = openAppWindow(browser, port);
        if (h) { CloseHandle(h); return 0; }
    }
    wchar_t url[64];
    _snwprintf(url, 63, L"http://127.0.0.1:%u/", (unsigned)port);
    url[63] = 0;
    ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL);
    return 0;
}

/* ---------- main ---------- */

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE hPrev, PWSTR cmdLine, int show) {
    (void)hInst; (void)hPrev; (void)cmdLine; (void)show;
    if (!initPaths()) {
        MessageBoxW(NULL, L"Could not find your local app data folder.", APP_NAME, MB_OK | MB_ICONERROR);
        return 1;
    }
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        showError(L"Windows networking is not available.");
        return 1;
    }

    HANDLE mutex = CreateMutexW(NULL, TRUE, MUTEX_NAME);
    if (mutex && GetLastError() == ERROR_ALREADY_EXISTS) {
        int rc = runSecondInstance();
        CloseHandle(mutex);
        WSACleanup();
        return rc;
    }
    logMsg(L"---- launcher start (%ls)", g_exeDir);

    Server srv;
    ZeroMemory(&srv, sizeof(srv));
    srv.job = CreateJobObjectW(NULL, NULL);
    if (srv.job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION li;
        ZeroMemory(&li, sizeof(li));
        li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(srv.job, JobObjectExtendedLimitInformation, &li, sizeof(li));
    }

    srv.port = pickPort();
    if (!srv.port) {
        showError(L"Could not find a free network port on this computer.");
        return 1;
    }
    writePortFile(srv.port);

    int rc = 0;
    if (!startServer(&srv) || !waitForHealth(&srv)) {
        rc = 1;
        goto done;
    }

    wchar_t browser[MAX_PATH];
    HANDLE win = NULL;
    ULONGLONG openedAt = GetTickCount64();
    if (findAnyBrowser(browser)) win = openAppWindow(browser, srv.port);
    if (!win) {
        logMsg(L"no Edge/Chrome found, using the default browser");
        openInDefaultBrowserAndWait(srv.port);
        goto done;
    }

    int restarts = 0;
    int goneChecks = 0;
    BOOL sawProfileLock = FALSE;
    BOOL exitedQuickly = FALSE;
    for (;;) {
        HANDLE hs[2] = { srv.process, win };
        DWORD count = win ? 2 : 1;
        DWORD r = WaitForMultipleObjects(count, hs, FALSE, 500);
        if (r == WAIT_OBJECT_0) {
            DWORD code = 0;
            GetExitCodeProcess(srv.process, &code);
            CloseHandle(srv.process);
            srv.process = NULL;
            logMsg(L"server exited unexpectedly with code %lu", code);
            if (++restarts > MAX_RESTARTS || !startServer(&srv) || !waitForHealth(&srv)) {
                showError(L"The Prompt2Print server stopped and could not be restarted.\n\nDetails are in:\n%ls", g_serverLog);
                rc = 1;
                break;
            }
            continue;
        }
        if (win && r == WAIT_OBJECT_0 + 1) {
            CloseHandle(win);
            win = NULL;
            exitedQuickly = GetTickCount64() - openedAt < 5000;
            logMsg(L"browser process exited%ls", exitedQuickly ? L" right away (hand-off?)" : L"");
            continue;
        }

        /* Timeout tick: is any window still using our browser profile? */
        if (profileInUse()) { sawProfileLock = TRUE; goneChecks = 0; continue; }
        if (win) continue;                                   /* browser still running */
        if (sawProfileLock) { if (++goneChecks >= 3) break; continue; }  /* last window closed */
        if (!exitedQuickly) break;                           /* window was open, now closed */
        if (GetTickCount64() - openedAt < 8000) continue;    /* give a hand-off time to settle */

        /* The browser handed the window to a process we cannot track:
           let the user decide when to stop the server. */
        logMsg(L"cannot track the app window; showing the stop dialog");
        wchar_t msg[256];
        _snwprintf(msg, 255, L"Prompt2Print is running at http://127.0.0.1:%u/\n\nClick OK to stop it.", (unsigned)srv.port);
        msg[255] = 0;
        MessageBoxW(NULL, msg, APP_NAME, MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND);
        break;
    }

done:
    if (srv.job) {
        TerminateJobObject(srv.job, 0);
        CloseHandle(srv.job);
    }
    if (srv.process) CloseHandle(srv.process);
    DeleteFileW(g_portFile);
    logMsg(L"launcher exit (%d)", rc);
    if (mutex) { ReleaseMutex(mutex); CloseHandle(mutex); }
    WSACleanup();
    return rc;
}
