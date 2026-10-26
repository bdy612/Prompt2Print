/* Test double for msedge.exe: records its command line, holds <user-data-dir>\lockfile
   (delete-on-close, like Chromium) for FAKE_EDGE_SECONDS, optionally handing off to a child first. */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <wchar.h>
#include <stdio.h>
int WINAPI wWinMain(HINSTANCE a, HINSTANCE b, PWSTR c, int d) {
    (void)a; (void)b; (void)c; (void)d;
    wchar_t *cmd = GetCommandLineW();
    wchar_t dir[MAX_PATH] = L"";
    wchar_t *p = wcsstr(cmd, L"--user-data-dir=\"");
    if (p) { p += 17; wchar_t *q = wcschr(p, L'"'); if (q) { wcsncpy(dir, p, q - p); dir[q - p] = 0; } }
    wchar_t buf[64]; DWORD secs = 8;
    if (GetEnvironmentVariableW(L"FAKE_EDGE_SECONDS", buf, 64)) secs = (DWORD)_wtoi(buf);
    BOOL handoff = GetEnvironmentVariableW(L"FAKE_EDGE_HANDOFF", buf, 64) && !wcsstr(cmd, L"--child");
    wchar_t path[MAX_PATH];
    _snwprintf(path, MAX_PATH, L"%ls\\args.txt", dir);
    FILE *f = _wfopen(path, L"a"); if (f) { fwprintf(f, L"%ls\n", cmd); fclose(f); }
    if (handoff) {
        wchar_t child[8192]; _snwprintf(child, 8191, L"%ls --child", cmd);
        STARTUPINFOW si = { sizeof(si) }; PROCESS_INFORMATION pi;
        if (CreateProcessW(NULL, child, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) { CloseHandle(pi.hThread); CloseHandle(pi.hProcess); }
        return 0;
    }
    _snwprintf(path, MAX_PATH, L"%ls\\lockfile", dir);
    HANDLE h = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_FLAG_DELETE_ON_CLOSE, NULL);
    Sleep(secs * 1000);
    if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
    return 0;
}
