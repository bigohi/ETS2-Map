// Loads ets2map_telemetry.dll exactly like the game does, feeds it fake
// telemetry through the SDK callbacks and checks the UDP datagram it sends.
// Usage: harness.exe [path\to\ets2map_telemetry.dll]

#define WIN32_LEAN_AND_MEAN
#define _CRT_SECURE_NO_WARNINGS
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <string>
#include <map>

#include "scssdk_telemetry.h"
#include "eurotrucks2/scssdk_eut2.h"
#include "eurotrucks2/scssdk_telemetry_eut2.h"
#include "common/scssdk_telemetry_common_configs.h"
#include "common/scssdk_telemetry_common_channels.h"
#include "common/scssdk_telemetry_truck_common_channels.h"

struct channel_reg { scs_telemetry_channel_callback_t cb; scs_context_t ctx; scs_value_type_t type; };
static std::map<scs_event_t, scs_telemetry_event_callback_t> g_events;
static std::map<std::string, channel_reg> g_channels;

static SCSAPI_RESULT reg_event(const scs_event_t e, const scs_telemetry_event_callback_t cb, const scs_context_t) { g_events[e] = cb; return SCS_RESULT_ok; }
static SCSAPI_RESULT unreg_event(const scs_event_t e) { g_events.erase(e); return SCS_RESULT_ok; }
static SCSAPI_RESULT reg_channel(const scs_string_t name, const scs_u32_t, const scs_value_type_t type, const scs_u32_t, const scs_telemetry_channel_callback_t cb, const scs_context_t ctx)
{
    if (strcmp(name, "trailer.connected") == 0) return SCS_RESULT_not_found; // mimic 1.14 game
    g_channels[name] = { cb, ctx, type };
    return SCS_RESULT_ok;
}
static SCSAPI_RESULT unreg_channel(const scs_string_t name, const scs_u32_t, const scs_value_type_t) { g_channels.erase(name); return SCS_RESULT_ok; }
static SCSAPI_VOID game_log(const scs_log_type_t, const scs_string_t msg) { printf("  game log: %s\n", msg); }

static void fire(scs_event_t e, const void *info) { auto it = g_events.find(e); if (it != g_events.end()) it->second(e, info, NULL); }

static void set_channel(const char *name, const scs_value_t &v)
{
    auto it = g_channels.find(name);
    if (it == g_channels.end()) { printf("  (channel %s not registered)\n", name); return; }
    it->second.cb(name, SCS_U32_NIL, &v, it->second.ctx);
}
static void set_float(const char *name, float f) { scs_value_t v{}; v.type = SCS_VALUE_TYPE_float; v.value_float.value = f; set_channel(name, v); }
static void set_u32(const char *name, scs_u32_t u) { scs_value_t v{}; v.type = SCS_VALUE_TYPE_u32; v.value_u32.value = u; set_channel(name, v); }
static void set_s32(const char *name, scs_s32_t s) { scs_value_t v{}; v.type = SCS_VALUE_TYPE_s32; v.value_s32.value = s; set_channel(name, v); }
static void set_bool(const char *name, bool b) { scs_value_t v{}; v.type = SCS_VALUE_TYPE_bool; v.value_bool.value = b; set_channel(name, v); }

static scs_named_value_t str_attr(const char *name, const char *value) { scs_named_value_t a{}; a.name = name; a.index = SCS_U32_NIL; a.value.type = SCS_VALUE_TYPE_string; a.value.value_string.value = value; return a; }
static scs_named_value_t u32_attr(const char *name, scs_u32_t value) { scs_named_value_t a{}; a.name = name; a.index = SCS_U32_NIL; a.value.type = SCS_VALUE_TYPE_u32; a.value.value_u32.value = value; return a; }
static scs_named_value_t u64_attr(const char *name, scs_u64_t value) { scs_named_value_t a{}; a.name = name; a.index = SCS_U32_NIL; a.value.type = SCS_VALUE_TYPE_u64; a.value.value_u64.value = value; return a; }
static scs_named_value_t f_attr(const char *name, float value) { scs_named_value_t a{}; a.name = name; a.index = SCS_U32_NIL; a.value.type = SCS_VALUE_TYPE_float; a.value.value_float.value = value; return a; }

int main(int argc, char **argv)
{
    const char *dll = argc > 1 ? argv[1] : "ets2map_telemetry.dll";
    int failures = 0;

    WSADATA wsa; WSAStartup(MAKEWORD(2, 2), &wsa);
    SOCKET rx = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    sockaddr_in addr{}; addr.sin_family = AF_INET; addr.sin_port = htons(30299);
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
    if (bind(rx, (sockaddr *)&addr, sizeof(addr)) != 0) { printf("FAIL bind\n"); return 1; }
    DWORD timeout = 1000; setsockopt(rx, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout, sizeof(timeout));
    SetEnvironmentVariableA("ETS2MAP_PORT", "30299");

    HMODULE h = LoadLibraryA(dll);
    if (!h) { printf("FAIL LoadLibrary(%s) error %lu\n", dll, GetLastError()); return 1; }
    typedef SCSAPI_RESULT_FPTR(init_fn)(const scs_u32_t, const scs_telemetry_init_params_t *const);
    typedef SCSAPI_VOID_FPTR(shutdown_fn)(void);
    init_fn init = (init_fn)GetProcAddress(h, "scs_telemetry_init");
    shutdown_fn shutdown = (shutdown_fn)GetProcAddress(h, "scs_telemetry_shutdown");
    if (!init || !shutdown) { printf("FAIL exports missing (init=%p shutdown=%p)\n", (void *)init, (void *)shutdown); return 1; }
    printf("OK   exports scs_telemetry_init / scs_telemetry_shutdown found\n");

    scs_telemetry_init_params_v101_t params{};
    params.common.game_name = "Euro Truck Simulator 2";
    params.common.game_id = SCS_GAME_ID_EUT2;
    params.common.game_version = SCS_TELEMETRY_EUT2_GAME_VERSION_CURRENT;
    params.common.log = game_log;
    params.register_for_event = reg_event;
    params.unregister_from_event = unreg_event;
    params.register_for_channel = reg_channel;
    params.unregister_from_channel = unreg_channel;

    scs_result_t r = init(SCS_TELEMETRY_VERSION_1_01, &params);
    printf("%s init -> %d, %zu events, %zu channels\n", r == SCS_RESULT_ok ? "OK  " : "FAIL", r, g_events.size(), g_channels.size());
    if (r != SCS_RESULT_ok) failures++;

    // Configuration: truck + job (UTF-8 names with quotes to test escaping).
    scs_named_value_t truck_attrs[] = { str_attr("brand", "Volvo"), str_attr("name", "FH \"Aero\""), f_attr("fuel.capacity", 900.0f), {} };
    scs_telemetry_configuration_t truck_cfg{ SCS_TELEMETRY_CONFIG_truck, truck_attrs };
    fire(SCS_TELEMETRY_EVENT_configuration, &truck_cfg);
    scs_named_value_t job_attrs[] = {
        str_attr("cargo", "Pommes"), str_attr("cargo.id", "apples"), f_attr("cargo.mass", 18000.0f),
        str_attr("source.city", "Calais"), str_attr("source.city.id", "calais"), str_attr("source.company", "Tradeaux"), str_attr("source.company.id", "tradeaux"),
        str_attr("destination.city", "Düsseldorf"), str_attr("destination.city.id", "dusseldorf"), str_attr("destination.company", "Stokes"), str_attr("destination.company.id", "stokes"),
        u64_attr("income", 12345), u32_attr("delivery.time", 4321), u32_attr("planned_distance.km", 512), str_attr("job.market", "freight_market"), {} };
    scs_telemetry_configuration_t job_cfg{ SCS_TELEMETRY_CONFIG_job, job_attrs };
    fire(SCS_TELEMETRY_EVENT_configuration, &job_cfg);

    // Channels.
    scs_value_t pl{}; pl.type = SCS_VALUE_TYPE_dplacement;
    pl.value_dplacement.position.x = -31234.5; pl.value_dplacement.position.y = 42.0; pl.value_dplacement.position.z = -5432.25;
    pl.value_dplacement.orientation.heading = 0.25f;
    set_channel(SCS_TELEMETRY_TRUCK_CHANNEL_world_placement, pl);
    set_float(SCS_TELEMETRY_TRUCK_CHANNEL_speed, 22.2f);
    set_float(SCS_TELEMETRY_TRUCK_CHANNEL_cruise_control, 23.6f);
    set_float(SCS_TELEMETRY_TRUCK_CHANNEL_navigation_speed_limit, 25.0f);
    set_float(SCS_TELEMETRY_TRUCK_CHANNEL_navigation_distance, 123456.0f);
    set_float(SCS_TELEMETRY_TRUCK_CHANNEL_navigation_time, 5400.0f);
    set_float(SCS_TELEMETRY_TRUCK_CHANNEL_fuel, 456.5f);
    set_u32(SCS_TELEMETRY_CHANNEL_game_time, 3000);
    set_s32(SCS_TELEMETRY_CHANNEL_next_rest_stop, 600);
    set_bool("trailer.0.connected", true);

    scs_telemetry_frame_start_t fs{}; fs.paused_simulation_time = 777;
    fire(SCS_TELEMETRY_EVENT_started, NULL);
    fire(SCS_TELEMETRY_EVENT_frame_start, &fs);
    fire(SCS_TELEMETRY_EVENT_frame_end, NULL);

    char buf[4096];
    int n = recv(rx, buf, sizeof(buf) - 1, 0);
    if (n <= 0) { printf("FAIL no datagram received\n"); failures++; }
    else {
        buf[n] = 0;
        printf("OK   datagram (%d bytes):\n%s\n", n, buf);
        const char *expect[] = { "\"paused\":false", "\"x\":-31234.500", "\"z\":-5432.250", "\"h\":0.250000", "\"spd\":22.200",
                                 "\"name\":\"FH \\\"Aero\\\"\"", "\"dst\":\"Düsseldorf\"", "\"dstCoId\":\"stokes\"", "\"km\":512", "\"trailers\":1", "\"gt\":3000" };
        for (const char *e : expect) {
            bool ok = strstr(buf, e) != NULL;
            printf("%s contains %s\n", ok ? "OK  " : "FAIL", e);
            if (!ok) failures++;
        }
    }

    // Throttle: a second frame_end right away must not send (20 Hz limit).
    fire(SCS_TELEMETRY_EVENT_frame_end, NULL);
    timeout = 30; setsockopt(rx, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout, sizeof(timeout));
    n = recv(rx, buf, sizeof(buf) - 1, 0);
    printf("%s throttled second frame (%s)\n", n <= 0 ? "OK  " : "FAIL", n <= 0 ? "nothing sent" : "sent too early");
    if (n > 0) failures++;

    // Pause event sends immediately with paused=true; job cleared by empty config.
    scs_named_value_t empty[] = { {} };
    scs_telemetry_configuration_t nojob{ SCS_TELEMETRY_CONFIG_job, empty };
    fire(SCS_TELEMETRY_EVENT_configuration, &nojob);
    fire(SCS_TELEMETRY_EVENT_paused, NULL);
    fire(SCS_TELEMETRY_EVENT_frame_end, NULL);
    timeout = 1000; setsockopt(rx, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout, sizeof(timeout));
    n = recv(rx, buf, sizeof(buf) - 1, 0);
    bool pause_ok = n > 0 && (buf[n] = 0, strstr(buf, "\"paused\":true") && strstr(buf, "\"job\":null"));
    printf("%s pause + job cleared packet\n", pause_ok ? "OK  " : "FAIL");
    if (!pause_ok) failures++;

    shutdown();

    // Started with the game: nothing listens on the port, ets2map_home.txt points
    // to a folder with a launcher. It must run, then die with the game.
    closesocket(rx);
    {
        char tmp[MAX_PATH], home[MAX_PATH], path[MAX_PATH * 2], full[MAX_PATH];
        GetTempPathA(sizeof(tmp), tmp);
        snprintf(home, sizeof(home), "%sets2map-harness-%lu", tmp, GetCurrentProcessId());
        CreateDirectoryA(home, NULL);
        snprintf(path, sizeof(path), "%s\\data", home);
        CreateDirectoryA(path, NULL);
        snprintf(path, sizeof(path), "%s\\data\\config.json", home);   // not a first launch: window minimized
        FILE *f = fopen(path, "w"); if (f) { fputs("{}", f); fclose(f); }
        snprintf(path, sizeof(path), "%s\\ETS2-Map.cmd", home);
        f = fopen(path, "w");
        if (f) { fputs("@echo off\r\n:loop\r\necho x>>\"%~dp0beat.txt\"\r\nping -n 2 127.0.0.1 >nul\r\ngoto loop\r\n", f); fclose(f); }
        char beat[MAX_PATH * 2];
        snprintf(beat, sizeof(beat), "%s\\beat.txt", home);
        auto beats = [&]() -> long {
            WIN32_FILE_ATTRIBUTE_DATA d;
            return GetFileAttributesExA(beat, GetFileExInfoStandard, &d) ? (long)d.nFileSizeLow : -1;
        };

        GetFullPathNameA(dll, sizeof(full), full, NULL);
        char *slash = strrchr(full, '\\');
        std::string home_file = std::string(full, slash ? slash + 1 - full : 0) + "ets2map_home.txt";
        f = fopen(home_file.c_str(), "w"); if (f) { fprintf(f, "%s\\\r\n", home); fclose(f); }

        r = init(SCS_TELEMETRY_VERSION_1_01, &params);
        long first = -1;
        for (int i = 0; i < 50 && first < 0; ++i) { Sleep(100); first = beats(); }
        printf("%s launcher started with the game\n", first >= 0 ? "OK  " : "FAIL");
        if (first < 0) failures++;
        Sleep(2500);
        const long running = beats();
        printf("%s launcher keeps running (%ld -> %ld bytes)\n", running > first ? "OK  " : "FAIL", first, running);
        if (!(running > first)) failures++;

        shutdown();
        Sleep(500);
        const long stopped = beats();
        Sleep(3000);
        const long later = beats();
        printf("%s launcher closed with the game (%ld -> %ld bytes)\n", later == stopped ? "OK  " : "FAIL", stopped, later);
        if (later != stopped) failures++;

        // Off on request.
        DeleteFileA(beat);
        SetEnvironmentVariableA("ETS2MAP_AUTOSTART", "0");
        r = init(SCS_TELEMETRY_VERSION_1_01, &params);
        Sleep(1500);
        printf("%s ETS2MAP_AUTOSTART=0 starts nothing\n", beats() < 0 ? "OK  " : "FAIL");
        if (beats() >= 0) failures++;
        shutdown();

        DeleteFileA(home_file.c_str());
        DeleteFileA(beat);
        snprintf(path, sizeof(path), "%s\\ETS2-Map.cmd", home); DeleteFileA(path);
        snprintf(path, sizeof(path), "%s\\data\\config.json", home); DeleteFileA(path);
        snprintf(path, sizeof(path), "%s\\data", home); RemoveDirectoryA(path);
        RemoveDirectoryA(home);
    }
    FreeLibrary(h);
    printf(failures ? "\n%d FAILURE(S)\n" : "\nALL CHECKS PASSED\n", failures);
    return failures ? 1 : 0;
}
