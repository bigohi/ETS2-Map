// ETS2-Map telemetry plugin.
//
// Loaded by Euro Truck Simulator 2 / American Truck Simulator from
// <game>\bin\win_x64\plugins\. Collects the truck position and route-advisor
// data through the official SCS Telemetry SDK and sends one small JSON
// datagram over UDP to 127.0.0.1:30210 (env ETS2MAP_PORT overrides) about 20
// times per second. The ETS2-Map server forwards it to the phone.
//
// Everything runs on the game thread and never blocks: the socket is
// non-blocking and a dropped datagram is simply replaced by the next one.

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "scssdk_telemetry.h"
#include "eurotrucks2/scssdk_eut2.h"
#include "eurotrucks2/scssdk_telemetry_eut2.h"
#include "amtrucks/scssdk_ats.h"
#include "amtrucks/scssdk_telemetry_ats.h"
#include "common/scssdk_telemetry_common_configs.h"
#include "common/scssdk_telemetry_common_channels.h"
#include "common/scssdk_telemetry_truck_common_channels.h"

#define PLUGIN_VERSION "1.1.0"
#define DEFAULT_PORT 30210
#define SEND_INTERVAL_MS 50       // 20 Hz while driving
#define PAUSED_INTERVAL_MS 1000   // 1 Hz while paused / in menus

// ---------------------------------------------------------------------------
// State filled by the SDK callbacks.

struct job_info_t {
    bool active;
    char cargo[128];
    char cargo_id[64];
    char src_city[96], src_city_id[64], src_company[96], src_company_id[64];
    char dst_city[96], dst_city_id[64], dst_company[96], dst_company_id[64];
    char market[32];
    float cargo_mass;      // kg
    scs_u64_t income;
    scs_u32_t delivery_time; // absolute game time, minutes
    scs_u32_t planned_km;
    bool special;
};

struct truck_info_t {
    char brand[64];
    char name[64];
    float fuel_capacity;   // liters
};

struct telemetry_t {
    double x, y, z;
    float heading, pitch, roll;
    float speed;           // m/s, negative when reversing
    float cruise;          // m/s, 0 when off
    float limit;           // m/s, 0 when none
    float nav_distance;    // m
    float nav_time;        // s
    float fuel;            // liters
    float fuel_range;      // km
    scs_u32_t game_time;   // minutes since game start
    scs_s32_t rest_stop;   // minutes until rest needed
    float local_scale;
    scs_s32_t gear;
    bool engine;
    bool parking_brake;
    scs_u32_t trailers;    // trailers currently attached (bit set per index)
};

static telemetry_t g_t;
static job_info_t g_job;
static truck_info_t g_truck;
static bool g_paused = true;
static char g_game_id[16] = "";
static scs_u32_t g_game_version = 0;
static scs_timestamp_t g_sim_time = 0;
static ULONGLONG g_last_send = 0;
static unsigned long g_seq = 0;

static SOCKET g_sock = INVALID_SOCKET;
static sockaddr_in g_dest;
static scs_log_t g_log = NULL;

// ---------------------------------------------------------------------------
// Helpers.

static void log_msg(scs_log_type_t type, const char *fmt, ...)
{
    if (!g_log) return;
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    _vsnprintf_s(buf, sizeof(buf), _TRUNCATE, fmt, ap);
    va_end(ap);
    char line[560];
    _snprintf_s(line, sizeof(line), _TRUNCATE, "[ets2map] %s", buf);
    g_log(type, line);
}

static void copy_str(char *dst, size_t cap, scs_string_t src)
{
    if (!src) { dst[0] = 0; return; }
    strncpy_s(dst, cap, src, _TRUNCATE);
}

// Appends a JSON string literal (with quotes) to out. Returns new length.
static size_t json_str(char *out, size_t len, size_t cap, const char *s)
{
    if (len + 2 >= cap) return len;
    out[len++] = '"';
    for (const unsigned char *p = (const unsigned char *)s; *p && len + 7 < cap; ++p) {
        unsigned char c = *p;
        if (c == '"' || c == '\\') { out[len++] = '\\'; out[len++] = (char)c; }
        else if (c < 0x20) { len += _snprintf_s(out + len, cap - len, _TRUNCATE, "\\u%04x", c); }
        else out[len++] = (char)c;
    }
    out[len++] = '"';
    out[len] = 0;
    return len;
}

static size_t appendf(char *out, size_t len, size_t cap, const char *fmt, ...)
{
    if (len >= cap) return len;
    va_list ap;
    va_start(ap, fmt);
    int n = _vsnprintf_s(out + len, cap - len, _TRUNCATE, fmt, ap);
    va_end(ap);
    return n < 0 ? cap - 1 : len + (size_t)n;
}

static size_t append_kv_str(char *out, size_t len, size_t cap, const char *key, const char *value)
{
    len = appendf(out, len, cap, ",\"%s\":", key);
    return json_str(out, len, cap, value);
}

static void send_packet(void)
{
    if (g_sock == INVALID_SOCKET) return;

    static char buf[4096];
    size_t n = 0;
    const size_t cap = sizeof(buf);

    n = appendf(buf, n, cap,
        "{\"v\":1,\"seq\":%lu,\"game\":\"%s\",\"gv\":\"%u.%u\",\"paused\":%s,\"sim\":%llu,"
        "\"x\":%.3f,\"y\":%.3f,\"z\":%.3f,\"h\":%.6f,\"p\":%.5f,\"r\":%.5f,"
        "\"spd\":%.3f,\"cc\":%.3f,\"lim\":%.3f,\"nd\":%.1f,\"nt\":%.1f,"
        "\"fuel\":%.2f,\"range\":%.1f,\"gt\":%u,\"rest\":%d,\"scale\":%.2f,"
        "\"gear\":%d,\"engine\":%s,\"pbrake\":%s,\"trailers\":%u",
        g_seq++, g_game_id,
        SCS_GET_MAJOR_VERSION(g_game_version), SCS_GET_MINOR_VERSION(g_game_version),
        g_paused ? "true" : "false", (unsigned long long)g_sim_time,
        g_t.x, g_t.y, g_t.z, g_t.heading, g_t.pitch, g_t.roll,
        g_t.speed, g_t.cruise, g_t.limit, g_t.nav_distance, g_t.nav_time,
        g_t.fuel, g_t.fuel_range, g_t.game_time, g_t.rest_stop, g_t.local_scale,
        g_t.gear, g_t.engine ? "true" : "false", g_t.parking_brake ? "true" : "false",
        g_t.trailers);

    n = appendf(buf, n, cap, ",\"truck\":{\"fuelCap\":%.1f", g_truck.fuel_capacity);
    n = append_kv_str(buf, n, cap, "brand", g_truck.brand);
    n = append_kv_str(buf, n, cap, "name", g_truck.name);
    n = appendf(buf, n, cap, "}");

    if (g_job.active) {
        n = appendf(buf, n, cap,
            ",\"job\":{\"mass\":%.0f,\"income\":%llu,\"deliv\":%u,\"km\":%u,\"special\":%s",
            g_job.cargo_mass, (unsigned long long)g_job.income, g_job.delivery_time,
            g_job.planned_km, g_job.special ? "true" : "false");
        n = append_kv_str(buf, n, cap, "cargo", g_job.cargo);
        n = append_kv_str(buf, n, cap, "cargoId", g_job.cargo_id);
        n = append_kv_str(buf, n, cap, "src", g_job.src_city);
        n = append_kv_str(buf, n, cap, "srcId", g_job.src_city_id);
        n = append_kv_str(buf, n, cap, "srcCo", g_job.src_company);
        n = append_kv_str(buf, n, cap, "srcCoId", g_job.src_company_id);
        n = append_kv_str(buf, n, cap, "dst", g_job.dst_city);
        n = append_kv_str(buf, n, cap, "dstId", g_job.dst_city_id);
        n = append_kv_str(buf, n, cap, "dstCo", g_job.dst_company);
        n = append_kv_str(buf, n, cap, "dstCoId", g_job.dst_company_id);
        n = append_kv_str(buf, n, cap, "market", g_job.market);
        n = appendf(buf, n, cap, "}");
    } else {
        n = appendf(buf, n, cap, ",\"job\":null");
    }
    n = appendf(buf, n, cap, "}");

    sendto(g_sock, buf, (int)n, 0, (const sockaddr *)&g_dest, sizeof(g_dest));
}

// ---------------------------------------------------------------------------
// SDK callbacks.

static SCSAPI_VOID on_frame_start(const scs_event_t, const void *const event_info, const scs_context_t)
{
    const scs_telemetry_frame_start_t *info = static_cast<const scs_telemetry_frame_start_t *>(event_info);
    g_sim_time = info->paused_simulation_time;
}

static SCSAPI_VOID on_frame_end(const scs_event_t, const void *const, const scs_context_t)
{
    ULONGLONG now = GetTickCount64();
    ULONGLONG interval = g_paused ? PAUSED_INTERVAL_MS : SEND_INTERVAL_MS;
    if (now - g_last_send < interval) return;
    g_last_send = now;
    send_packet();
}

static SCSAPI_VOID on_pause(const scs_event_t event, const void *const, const scs_context_t)
{
    g_paused = (event == SCS_TELEMETRY_EVENT_paused);
    g_last_send = 0; // push the new state right away
}

static bool attr_is(const scs_named_value_t *a, const char *name) { return strcmp(a->name, name) == 0; }

static SCSAPI_VOID on_configuration(const scs_event_t, const void *const event_info, const scs_context_t)
{
    const scs_telemetry_configuration_t *cfg = static_cast<const scs_telemetry_configuration_t *>(event_info);

    if (strcmp(cfg->id, SCS_TELEMETRY_CONFIG_job) == 0) {
        memset(&g_job, 0, sizeof(g_job));
        for (const scs_named_value_t *a = cfg->attributes; a->name; ++a) {
            const scs_value_t &v = a->value;
            g_job.active = true;
            if (attr_is(a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_cargo)) copy_str(g_job.cargo, sizeof(g_job.cargo), v.value_string.value);
            else if (attr_is(a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_cargo_id)) copy_str(g_job.cargo_id, sizeof(g_job.cargo_id), v.value_string.value);
            else if (attr_is(a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_cargo_mass)) g_job.cargo_mass = v.value_float.value;
            else if (attr_is(a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_city)) copy_str(g_job.src_city, sizeof(g_job.src_city), v.value_string.value);
            else if (attr_is(a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_city_id)) copy_str(g_job.src_city_id, sizeof(g_job.src_city_id), v.value_string.value);
            else if (attr_is(a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_company)) copy_str(g_job.src_company, sizeof(g_job.src_company), v.value_string.value);
            else if (attr_is(a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_company_id)) copy_str(g_job.src_company_id, sizeof(g_job.src_company_id), v.value_string.value);
            else if (attr_is(a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_city)) copy_str(g_job.dst_city, sizeof(g_job.dst_city), v.value_string.value);
            else if (attr_is(a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_city_id)) copy_str(g_job.dst_city_id, sizeof(g_job.dst_city_id), v.value_string.value);
            else if (attr_is(a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_company)) copy_str(g_job.dst_company, sizeof(g_job.dst_company), v.value_string.value);
            else if (attr_is(a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_company_id)) copy_str(g_job.dst_company_id, sizeof(g_job.dst_company_id), v.value_string.value);
            else if (attr_is(a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_job_market)) copy_str(g_job.market, sizeof(g_job.market), v.value_string.value);
            else if (attr_is(a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_income)) g_job.income = v.value_u64.value;
            else if (attr_is(a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_delivery_time)) g_job.delivery_time = v.value_u32.value;
            else if (attr_is(a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_planned_distance_km)) g_job.planned_km = v.value_u32.value;
            else if (attr_is(a, "is_special_job")) g_job.special = v.value_bool.value != 0;
        }
    } else if (strcmp(cfg->id, SCS_TELEMETRY_CONFIG_truck) == 0) {
        memset(&g_truck, 0, sizeof(g_truck));
        for (const scs_named_value_t *a = cfg->attributes; a->name; ++a) {
            const scs_value_t &v = a->value;
            if (attr_is(a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_brand)) copy_str(g_truck.brand, sizeof(g_truck.brand), v.value_string.value);
            else if (attr_is(a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_name)) copy_str(g_truck.name, sizeof(g_truck.name), v.value_string.value);
            else if (attr_is(a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_fuel_capacity)) g_truck.fuel_capacity = v.value_float.value;
        }
    }
    g_last_send = 0;
}

static SCSAPI_VOID store_placement(const scs_string_t, const scs_u32_t, const scs_value_t *const value, const scs_context_t)
{
    if (!value) return;
    const scs_value_dplacement_t &p = value->value_dplacement;
    g_t.x = p.position.x; g_t.y = p.position.y; g_t.z = p.position.z;
    g_t.heading = p.orientation.heading; g_t.pitch = p.orientation.pitch; g_t.roll = p.orientation.roll;
}

static SCSAPI_VOID store_float(const scs_string_t, const scs_u32_t, const scs_value_t *const value, const scs_context_t ctx)
{
    *static_cast<float *>(ctx) = value ? value->value_float.value : 0.0f;
}

static SCSAPI_VOID store_u32(const scs_string_t, const scs_u32_t, const scs_value_t *const value, const scs_context_t ctx)
{
    *static_cast<scs_u32_t *>(ctx) = value ? value->value_u32.value : 0;
}

static SCSAPI_VOID store_s32(const scs_string_t, const scs_u32_t, const scs_value_t *const value, const scs_context_t ctx)
{
    *static_cast<scs_s32_t *>(ctx) = value ? value->value_s32.value : 0;
}

static SCSAPI_VOID store_bool(const scs_string_t, const scs_u32_t, const scs_value_t *const value, const scs_context_t ctx)
{
    *static_cast<bool *>(ctx) = value ? value->value_bool.value != 0 : false;
}

// The context carries the trailer slot (0..9).
static SCSAPI_VOID store_trailer_connected(const scs_string_t, const scs_u32_t, const scs_value_t *const value, const scs_context_t ctx)
{
    const scs_u32_t index = (scs_u32_t)(uintptr_t)ctx;
    if (index >= 32) return;
    if (value && value->value_bool.value) g_t.trailers |= (1u << index);
    else g_t.trailers &= ~(1u << index);
}

// ---------------------------------------------------------------------------
// Entry points.

static bool open_socket(void)
{
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return false;
    g_sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (g_sock == INVALID_SOCKET) return false;
    u_long nonblocking = 1;
    ioctlsocket(g_sock, FIONBIO, &nonblocking);

    int port = DEFAULT_PORT;
    char env[16];
    DWORD len = GetEnvironmentVariableA("ETS2MAP_PORT", env, sizeof(env));
    if (len > 0 && len < sizeof(env)) {
        int p = atoi(env);
        if (p > 0 && p < 65536) port = p;
    }
    memset(&g_dest, 0, sizeof(g_dest));
    g_dest.sin_family = AF_INET;
    g_dest.sin_port = htons((u_short)port);
    inet_pton(AF_INET, "127.0.0.1", &g_dest.sin_addr);
    log_msg(SCS_LOG_TYPE_message, "v" PLUGIN_VERSION " sending telemetry to udp://127.0.0.1:%d", port);
    return true;
}

static void close_socket(void)
{
    if (g_sock != INVALID_SOCKET) {
        closesocket(g_sock);
        g_sock = INVALID_SOCKET;
        WSACleanup();
    }
}

// ---------------------------------------------------------------------------
// ETS2 Map server, started with the game.
//
// ets2map_home.txt, next to this DLL, holds the ETS2 Map folder (written when
// the plugin is installed). If nothing listens on the telemetry port yet, the
// game starts the launcher found there, in its own minimized window, and the
// window closes with the game. ETS2MAP_AUTOSTART=0 turns this off.

static HANDLE g_server_job = NULL;

static bool file_exists(const wchar_t *path)
{
    const DWORD attr = GetFileAttributesW(path);
    return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

// The server holds the telemetry port: binding it fails while it runs.
static bool server_running(void)
{
    SOCKET s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s == INVALID_SOCKET) return true; // cannot tell: never start a second one
    const bool taken = bind(s, (const sockaddr *)&g_dest, sizeof(g_dest)) != 0;
    closesocket(s);
    return taken;
}

static bool read_home(wchar_t *home, size_t cap)
{
    HMODULE self = NULL;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (LPCWSTR)&g_server_job, &self)) return false;
    wchar_t path[1024];
    const DWORD n = GetModuleFileNameW(self, path, 1000);
    if (n == 0 || n >= 1000) return false;
    wchar_t *slash = wcsrchr(path, L'\\');
    if (!slash) return false;
    wcscpy_s(slash + 1, 24, L"ets2map_home.txt");

    HANDLE f = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) return false;
    char utf8[2048];
    DWORD got = 0;
    const BOOL ok = ReadFile(f, utf8, sizeof(utf8) - 1, &got, NULL);
    CloseHandle(f);
    if (!ok || got == 0) return false;
    utf8[got] = 0;
    const char *start = utf8;
    if (got >= 3 && (unsigned char)utf8[0] == 0xEF && (unsigned char)utf8[1] == 0xBB && (unsigned char)utf8[2] == 0xBF) start += 3;
    size_t len = strcspn(start, "\r\n");
    while (len > 0 && (start[len - 1] == ' ' || start[len - 1] == '\\' || start[len - 1] == '/')) len--;
    if (len == 0) return false;
    const int w = MultiByteToWideChar(CP_UTF8, 0, start, (int)len, home, (int)cap - 1);
    if (w <= 0) return false;
    home[w] = 0;
    return true;
}

static void start_server(void)
{
    char env[8];
    const DWORD len = GetEnvironmentVariableA("ETS2MAP_AUTOSTART", env, sizeof(env));
    if (len == 1 && env[0] == '0') return;
    if (server_running()) { log_msg(SCS_LOG_TYPE_message, "ETS2 Map is already running"); return; }

    wchar_t home[600];
    if (!read_home(home, 600)) { log_msg(SCS_LOG_TYPE_message, "no ets2map_home.txt next to the plugin: start ETS2 Map by hand"); return; }

    // The launcher of the source folder, else the one of the friends' pack.
    static const wchar_t *const launchers[] = { L"ETS2-Map.cmd", L"2 - Lancer ETS2 Map.cmd" };
    wchar_t launcher[800] = L"";
    for (size_t i = 0; i < 2 && !launcher[0]; ++i) {
        _snwprintf_s(launcher, 800, _TRUNCATE, L"%s\\%s", home, launchers[i]);
        if (!file_exists(launcher)) launcher[0] = 0;
    }
    if (!launcher[0]) { log_msg(SCS_LOG_TYPE_warning, "ETS2 Map launcher not found in the folder of ets2map_home.txt"); return; }

    wchar_t comspec[300];
    const DWORD cs = GetEnvironmentVariableW(L"ComSpec", comspec, 300);
    if (cs == 0 || cs >= 300) wcscpy_s(comspec, 300, L"cmd.exe");
    wchar_t cmdline[1400];
    _snwprintf_s(cmdline, 1400, _TRUNCATE, L"\"%s\" /c \"\"%s\"\"", comspec, launcher);

    // First launch asks for the nickname and the convoy code: show the window.
    // Later ones stay minimized and leave the keyboard to the game.
    wchar_t config[800];
    _snwprintf_s(config, 800, _TRUNCATE, L"%s\\data\\config.json", home);
    STARTUPINFOW si;
    memset(&si, 0, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = (WORD)(file_exists(config) ? SW_SHOWMINNOACTIVE : SW_SHOWNORMAL);
    PROCESS_INFORMATION pi;
    memset(&pi, 0, sizeof(pi));
    if (!CreateProcessW(NULL, cmdline, NULL, NULL, FALSE, CREATE_NEW_CONSOLE | CREATE_SUSPENDED, NULL, home, &si, &pi)) {
        log_msg(SCS_LOG_TYPE_warning, "unable to start ETS2 Map (error %lu)", GetLastError());
        return;
    }
    // A job that dies with the game: closing ETS2 closes the server window.
    g_server_job = CreateJobObjectW(NULL, NULL);
    if (g_server_job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
        memset(&limits, 0, sizeof(limits));
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(g_server_job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
            !AssignProcessToJobObject(g_server_job, pi.hProcess)) {
            CloseHandle(g_server_job);
            g_server_job = NULL;
        }
    }
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    log_msg(SCS_LOG_TYPE_message, "ETS2 Map started with the game%s", g_server_job ? "" : " (it will stay open after the game)");
}

static void stop_server(void)
{
    if (g_server_job) {
        CloseHandle(g_server_job); // kills what we started
        g_server_job = NULL;
    }
}

SCSAPI_RESULT scs_telemetry_init(const scs_u32_t version, const scs_telemetry_init_params_t *const params)
{
    if (version != SCS_TELEMETRY_VERSION_1_01) return SCS_RESULT_unsupported;
    const scs_telemetry_init_params_v101_t *const p = static_cast<const scs_telemetry_init_params_v101_t *>(params);

    g_log = p->common.log;
    copy_str(g_game_id, sizeof(g_game_id), p->common.game_id);
    g_game_version = p->common.game_version;

    memset(&g_t, 0, sizeof(g_t));
    memset(&g_job, 0, sizeof(g_job));
    memset(&g_truck, 0, sizeof(g_truck));
    g_paused = true;
    g_last_send = 0;

    const bool events_ok =
        p->register_for_event(SCS_TELEMETRY_EVENT_frame_start, on_frame_start, NULL) == SCS_RESULT_ok &&
        p->register_for_event(SCS_TELEMETRY_EVENT_frame_end, on_frame_end, NULL) == SCS_RESULT_ok &&
        p->register_for_event(SCS_TELEMETRY_EVENT_paused, on_pause, NULL) == SCS_RESULT_ok &&
        p->register_for_event(SCS_TELEMETRY_EVENT_started, on_pause, NULL) == SCS_RESULT_ok;
    if (!events_ok) {
        log_msg(SCS_LOG_TYPE_error, "unable to register event callbacks");
        return SCS_RESULT_generic_error;
    }
    p->register_for_event(SCS_TELEMETRY_EVENT_configuration, on_configuration, NULL);

    // Missing channels (older game versions) just stay at zero.
    p->register_for_channel(SCS_TELEMETRY_TRUCK_CHANNEL_world_placement, SCS_U32_NIL, SCS_VALUE_TYPE_dplacement, SCS_TELEMETRY_CHANNEL_FLAG_none, store_placement, NULL);
    p->register_for_channel(SCS_TELEMETRY_TRUCK_CHANNEL_speed, SCS_U32_NIL, SCS_VALUE_TYPE_float, SCS_TELEMETRY_CHANNEL_FLAG_none, store_float, &g_t.speed);
    p->register_for_channel(SCS_TELEMETRY_TRUCK_CHANNEL_cruise_control, SCS_U32_NIL, SCS_VALUE_TYPE_float, SCS_TELEMETRY_CHANNEL_FLAG_none, store_float, &g_t.cruise);
    p->register_for_channel(SCS_TELEMETRY_TRUCK_CHANNEL_navigation_speed_limit, SCS_U32_NIL, SCS_VALUE_TYPE_float, SCS_TELEMETRY_CHANNEL_FLAG_none, store_float, &g_t.limit);
    p->register_for_channel(SCS_TELEMETRY_TRUCK_CHANNEL_navigation_distance, SCS_U32_NIL, SCS_VALUE_TYPE_float, SCS_TELEMETRY_CHANNEL_FLAG_none, store_float, &g_t.nav_distance);
    p->register_for_channel(SCS_TELEMETRY_TRUCK_CHANNEL_navigation_time, SCS_U32_NIL, SCS_VALUE_TYPE_float, SCS_TELEMETRY_CHANNEL_FLAG_none, store_float, &g_t.nav_time);
    p->register_for_channel(SCS_TELEMETRY_TRUCK_CHANNEL_fuel, SCS_U32_NIL, SCS_VALUE_TYPE_float, SCS_TELEMETRY_CHANNEL_FLAG_none, store_float, &g_t.fuel);
    p->register_for_channel(SCS_TELEMETRY_TRUCK_CHANNEL_fuel_range, SCS_U32_NIL, SCS_VALUE_TYPE_float, SCS_TELEMETRY_CHANNEL_FLAG_none, store_float, &g_t.fuel_range);
    p->register_for_channel(SCS_TELEMETRY_TRUCK_CHANNEL_displayed_gear, SCS_U32_NIL, SCS_VALUE_TYPE_s32, SCS_TELEMETRY_CHANNEL_FLAG_none, store_s32, &g_t.gear);
    p->register_for_channel(SCS_TELEMETRY_TRUCK_CHANNEL_engine_enabled, SCS_U32_NIL, SCS_VALUE_TYPE_bool, SCS_TELEMETRY_CHANNEL_FLAG_none, store_bool, &g_t.engine);
    p->register_for_channel(SCS_TELEMETRY_TRUCK_CHANNEL_parking_brake, SCS_U32_NIL, SCS_VALUE_TYPE_bool, SCS_TELEMETRY_CHANNEL_FLAG_none, store_bool, &g_t.parking_brake);
    p->register_for_channel(SCS_TELEMETRY_CHANNEL_game_time, SCS_U32_NIL, SCS_VALUE_TYPE_u32, SCS_TELEMETRY_CHANNEL_FLAG_none, store_u32, &g_t.game_time);
    p->register_for_channel(SCS_TELEMETRY_CHANNEL_next_rest_stop, SCS_U32_NIL, SCS_VALUE_TYPE_s32, SCS_TELEMETRY_CHANNEL_FLAG_none, store_s32, &g_t.rest_stop);
    p->register_for_channel(SCS_TELEMETRY_CHANNEL_local_scale, SCS_U32_NIL, SCS_VALUE_TYPE_float, SCS_TELEMETRY_CHANNEL_FLAG_none, store_float, &g_t.local_scale);
    for (scs_u32_t i = 0; i < 10; ++i) {
        // "trailer.0.connected" ... the SDK 1.14 multi-trailer channels.
        char name[48];
        _snprintf_s(name, sizeof(name), _TRUNCATE, "trailer.%u.connected", i);
        if (p->register_for_channel(name, SCS_U32_NIL, SCS_VALUE_TYPE_bool, SCS_TELEMETRY_CHANNEL_FLAG_none, store_trailer_connected, (scs_context_t)(uintptr_t)i) != SCS_RESULT_ok && i == 0) {
            p->register_for_channel("trailer.connected", SCS_U32_NIL, SCS_VALUE_TYPE_bool, SCS_TELEMETRY_CHANNEL_FLAG_none, store_trailer_connected, NULL);
        }
    }

    if (!open_socket()) {
        log_msg(SCS_LOG_TYPE_error, "unable to open UDP socket, telemetry disabled");
        close_socket();
        // Keep the game running normally; the plugin just stays silent.
    } else {
        start_server();
    }
    return SCS_RESULT_ok;
}

SCSAPI_VOID scs_telemetry_shutdown(void)
{
    stop_server();
    close_socket();
    g_log = NULL;
}

BOOL APIENTRY DllMain(HMODULE, DWORD, LPVOID) { return TRUE; }
