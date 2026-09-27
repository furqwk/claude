// WebAssembly entry points for the deobfuscator's Luau runtime.
//
// The Python pipeline drives two command line programs, `luau` (run a file,
// or a REPL fed through stdin) and `luau-ast` (print a file's AST as JSON).
// This file builds both into one module that a browser worker calls
// synchronously. It includes the real CLI sources, so the globals
// (loadstring, collectgarbage, require) and the sandboxing match the native
// `luau` binary exactly.
//
// stdout/stderr go to files in the in-memory file system (/io/out, /io/err),
// read back by JavaScript after each call: the harness prints NUL bytes,
// which the default Emscripten print hooks would cut off.
//
// Timeouts: the VM interrupt callback checks the wall clock (and, for file
// runs, whether stdout stopped growing: the harness prints a heartbeat) and
// throws a C++ exception that Luau's protected calls do not catch, so a
// script's pcall cannot swallow it. The state is abandoned afterwards, like
// the killed process of the native pipeline.

#define main luau_repl_unused_main
#include "Repl.cpp" // CLI/src (on the include path)
#undef main

#include "Luau/Ast.h"
#include "Luau/AstJsonEncoder.h"
#include "Luau/Parser.h"
#include "Luau/ParseOptions.h"
#include "Luau/ToString.h"

#include <emscripten.h>
#include <stdio.h>
#include <unistd.h>

namespace
{
struct KillSignal
{
};

double deadline = 0;    // ms, 0 = none
double stallMs = 0;     // ms without stdout growth, 0 = no check
double lastGrowth = 0;
long lastPos = -1;
unsigned tick = 0;
bool killed = false;

void killCallback(lua_State* L, int gc)
{
    if (gc >= 0 || (++tick & 1023) != 0)
        return;
    double now = emscripten_get_now();
    if (stallMs > 0)
    {
        long pos = ftell(stdout);
        if (pos != lastPos)
        {
            lastPos = pos;
            lastGrowth = now;
        }
        else if (now - lastGrowth > stallMs)
        {
            killed = true;
            throw KillSignal();
        }
    }
    if (deadline > 0 && now > deadline)
    {
        killed = true;
        throw KillSignal();
    }
}

void openIo()
{
    freopen("/io/out", "w", stdout);
    freopen("/io/err", "w", stderr);
}

void closeIo()
{
    fflush(stdout);
    fflush(stderr);
}

void arm(lua_State* L, double timeoutSec, double stallSec)
{
    double now = emscripten_get_now();
    deadline = timeoutSec > 0 ? now + timeoutSec * 1000.0 : 0;
    stallMs = stallSec > 0 ? stallSec * 1000.0 : 0;
    lastGrowth = now;
    lastPos = -1;
    tick = 0;
    killed = false;
    lua_callbacks(L)->interrupt = killCallback;
}

lua_State* server = nullptr;
} // namespace

extern "C"
{

// `luau <path>`. Returns 0 (ran), 1 (script error) or 2 (killed: timeout/stall).
EMSCRIPTEN_KEEPALIVE int deobf_run(const char* path, double timeoutSec, double stallSec)
{
    openIo();
    lua_State* L = luaL_newstate();
    setupState(L);
    luaL_sandboxthread(L);
    arm(L, timeoutSec, stallSec);
    int rc;
    try
    {
        rc = runFile(path, L, false) ? 0 : 1;
        lua_close(L);
    }
    catch (KillSignal&)
    {
        rc = 2; // the state may be mid-operation: abandon it
    }
    closeIo();
    return rc;
}

// `luau` REPL started in `dir` (HarnessServer). Returns 0.
EMSCRIPTEN_KEEPALIVE int deobf_server_start(const char* dir)
{
    chdir(dir);
    server = luaL_newstate();
    setupState(server);
    luaL_sandboxthread(server);
    return 0;
}

// One REPL line: tried as `return <line>` first, then as a statement (the
// same order as the CLI's REPL). Output goes to /io/out. Returns 0, or 2
// when killed (the server is gone then).
EMSCRIPTEN_KEEPALIVE int deobf_server_exec(const char* line, double timeoutSec)
{
    if (!server)
        return 2;
    openIo();
    arm(server, timeoutSec, 0);
    int rc = 0;
    try
    {
        if (runCode(server, std::string("return ") + line) != std::string())
        {
            std::string error = runCode(server, line);
            if (error.length())
                fprintf(stdout, "%s\n", error.c_str());
        }
    }
    catch (KillSignal&)
    {
        server = nullptr;
        rc = 2;
    }
    if (server)
        lua_callbacks(server)->interrupt = NULL;
    closeIo();
    return rc;
}

EMSCRIPTEN_KEEPALIVE void deobf_server_stop()
{
    if (server)
        lua_close(server);
    server = nullptr;
}

// `luau-ast <path>`: JSON to /io/out, parse errors to /io/err.
// Returns 0, 1 (parse errors) or 2 (unreadable file).
EMSCRIPTEN_KEEPALIVE int deobf_ast(const char* path)
{
    static bool flagsSet = false;
    if (!flagsSet)
    {
        for (Luau::FValue<bool>* flag = Luau::FValue<bool>::list; flag; flag = flag->next)
            if (strncmp(flag->name, "Luau", 4) == 0)
                flag->value = true;
        flagsSet = true;
    }
    openIo();
    std::optional<std::string> maybeSource = readFile(path);
    if (!maybeSource)
    {
        fprintf(stderr, "Couldn't read source %s\n", path);
        closeIo();
        return 2;
    }
    std::string source = *maybeSource;

    Luau::Allocator allocator;
    Luau::AstNameTable names(allocator);

    Luau::ParseOptions options;
    options.captureComments = true;
    options.allowDeclarationSyntax = true;

    Luau::ParseResult parseResult = Luau::Parser::parse(source.data(), source.size(), names, allocator, std::move(options));

    if (parseResult.errors.size() > 0)
    {
        fprintf(stderr, "Parse errors were encountered:\n");
        for (const Luau::ParseError& error : parseResult.errors)
            fprintf(stderr, "  %s - %s\n", toString(error.getLocation()).c_str(), error.getMessage().c_str());
        fprintf(stderr, "\n");
    }

    std::string json = Luau::toJson(parseResult.root, parseResult.commentLocations);
    fwrite(json.data(), 1, json.size(), stdout);
    closeIo();
    return parseResult.errors.size() > 0 ? 1 : 0;
}
}
