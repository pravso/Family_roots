/*
 * Roots & Memories – Windows launcher
 *
 * Opens the deployed app in its own app window (no tabs or address bar) using
 * Microsoft Edge (built into Windows 10/11) or Google Chrome, with a separate
 * browser profile so the family login stays signed in.
 *
 * The app address is read from "app-url.txt" next to this .exe.
 *
 * Build (from Linux/macOS/Windows with Zig installed):
 *   zig rc /fo app.res app.rc
 *   zig cc -target x86_64-windows-gnu -municode -mwindows -Os launcher.c app.res \
 *          -o "Roots & Memories.exe" -lshell32 -luser32
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <wchar.h>

#define APP_NAME L"Roots & Memories"

static void exeDir(wchar_t *out, DWORD cap) {
    GetModuleFileNameW(NULL, out, cap);
    wchar_t *slash = wcsrchr(out, L'\\');
    if (slash) slash[1] = 0;
}

static int fileExists(const wchar_t *p) {
    DWORD a = GetFileAttributesW(p);
    return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

static void trim(wchar_t *s) {
    wchar_t *p = s;
    while (*p == L' ' || *p == L'\t' || *p == 0xFEFF) p++;
    if (p != s) memmove(s, p, (wcslen(p) + 1) * sizeof(wchar_t));
    size_t n = wcslen(s);
    while (n && (s[n - 1] == L' ' || s[n - 1] == L'\r' || s[n - 1] == L'\n' || s[n - 1] == L'\t')) s[--n] = 0;
}

/* Reads the first non-comment line of app-url.txt. Returns 1 if it looks like a valid https URL. */
static int readUrl(const wchar_t *path, wchar_t *url, int cap) {
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    char buf[4096];
    DWORD got = 0;
    ReadFile(h, buf, sizeof(buf) - 1, &got, NULL);
    CloseHandle(h);
    buf[got] = 0;

    char *line = buf;
    while (line && *line) {
        char *next = strchr(line, '\n');
        if (next) *next++ = 0;
        wchar_t w[2048];
        int n = MultiByteToWideChar(CP_UTF8, 0, line, -1, w, 2048);
        if (n > 0) {
            trim(w);
            if (w[0] && w[0] != L'#') {
                if (wcsncmp(w, L"https://", 8) != 0 || wcsstr(w, L"YOUR-") || wcschr(w, L'"') || wcslen(w) >= (size_t)cap) return 0;
                wcscpy(url, w);
                return 1;
            }
        }
        line = next;
    }
    return 0;
}

static void writeTemplate(const wchar_t *path) {
    HANDLE h = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    const char *t =
        "# Paste your Roots & Memories web address on the line below, save, and start the app again.\r\n"
        "https://family-roots.YOUR-SUBDOMAIN.workers.dev\r\n";
    DWORD w;
    WriteFile(h, t, (DWORD)strlen(t), &w, NULL);
    CloseHandle(h);
}

static int findBrowser(wchar_t *out, DWORD cap) {
    const wchar_t *candidates[] = {
        L"%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe",
        L"%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe",
        L"%LOCALAPPDATA%\\Microsoft\\Edge\\Application\\msedge.exe",
        L"%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe",
        L"%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe",
        L"%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe",
    };
    for (int i = 0; i < (int)(sizeof(candidates) / sizeof(candidates[0])); i++) {
        if (ExpandEnvironmentStringsW(candidates[i], out, cap) && fileExists(out)) return 1;
    }
    return 0;
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE hPrev, PWSTR cmd, int show) {
    (void)hInst; (void)hPrev; (void)cmd; (void)show;

    wchar_t dir[MAX_PATH], cfg[MAX_PATH], url[1024];
    exeDir(dir, MAX_PATH);
    wcscpy(cfg, dir);
    wcscat(cfg, L"app-url.txt");

    if (!readUrl(cfg, url, 1024)) {
        writeTemplate(cfg);
        int r = MessageBoxW(NULL,
            L"Roots & Memories needs your app's web address.\n\n"
            L"Click OK to open app-url.txt, paste the address (for example\n"
            L"https://family-roots.yourname.workers.dev), save it, and start the app again.",
            APP_NAME, MB_OKCANCEL | MB_ICONINFORMATION);
        if (r == IDOK) ShellExecuteW(NULL, L"open", L"notepad.exe", cfg, NULL, SW_SHOWNORMAL);
        return 0;
    }

    wchar_t browser[MAX_PATH];
    if (!findBrowser(browser, MAX_PATH)) {
        /* No Edge/Chrome found: fall back to the default browser. */
        ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL);
        return 0;
    }

    wchar_t profile[MAX_PATH];
    ExpandEnvironmentStringsW(L"%LOCALAPPDATA%\\RootsAndMemories", profile, MAX_PATH);
    CreateDirectoryW(profile, NULL);
    wcscat(profile, L"\\profile");
    CreateDirectoryW(profile, NULL);

    wchar_t line[4096];
    swprintf(line, 4096,
        L"\"%ls\" --app=\"%ls\" --user-data-dir=\"%ls\" --no-first-run --no-default-browser-check --window-size=860,900",
        browser, url, profile);

    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi;
    if (CreateProcessW(NULL, line, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    } else {
        ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL);
    }
    return 0;
}
