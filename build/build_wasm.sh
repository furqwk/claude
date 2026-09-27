#!/usr/bin/env bash
# Builds site/luau/luau_web.{mjs,wasm}: the deobfuscator's Luau runtime (the
# `luau` REPL/CLI and `luau-ast`) for the browser.
#
# Needs git, cmake, python3 and an activated Emscripten SDK (emcc on PATH).
#   build/build_wasm.sh [luau checkout]
# Without an argument Luau 0.739 is cloned into build/.luau (the version
# deobf/build_luau.py pins), with the same Vector3 metatable patch.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
TAG=0.739
SRC="${1:-$HERE/.luau}"
OUT="$ROOT/site/luau"

if [ ! -d "$SRC" ]; then
    git clone -q --depth 1 --branch "$TAG" https://github.com/luau-lang/luau.git "$SRC"
fi

# same patch as deobf/build_luau.py: leave the vector metatable writable
python3 -c "import sys; sys.path.insert(0, sys.argv[1]); import build_luau; build_luau.patch(sys.argv[2])" \
    "$ROOT/Deobfuscator/deobf" "$SRC"

BUILD="$SRC/build-wasm"
FLAGS="-O3 -fwasm-exceptions -DNDEBUG"
emcmake cmake -S "$SRC" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release \
    -DLUAU_BUILD_CLI=OFF -DLUAU_BUILD_TESTS=OFF \
    -DCMAKE_C_FLAGS_RELEASE="$FLAGS" -DCMAKE_CXX_FLAGS_RELEASE="$FLAGS" >/dev/null
cmake --build "$BUILD" --parallel --target \
    Luau.VM Luau.Compiler Luau.Ast Luau.Analysis Luau.Config Luau.Require \
    Luau.CLI.lib Luau.CodeGen Luau.Inliner Luau.Bytecode Luau.Common isocline

mkdir -p "$OUT"
LIBS=""
for l in CLI.lib Require Config Analysis Compiler Inliner CodeGen Bytecode VM Ast Common; do
    LIBS="$LIBS $(find "$BUILD" -name "libLuau.$l.a" | head -1)"
done
LIBS="$LIBS $(find "$BUILD" -name 'libisocline.a' | head -1)"

INC=""
for d in Common Ast Compiler Config Analysis CodeGen VM Require Bytecode CLI Inliner EqSat; do
    [ -d "$SRC/$d/include" ] && INC="$INC -I$SRC/$d/include"
done

em++ -std=c++17 $FLAGS $INC -I"$SRC/VM/src" -I"$SRC/CLI/src" -I"$SRC/extern" -I"$SRC/extern/isocline/include" \
    "$HERE/luau_web.cpp" \
    "$SRC/CLI/src/Counters.cpp" "$SRC/CLI/src/Coverage.cpp" "$SRC/CLI/src/Profiler.cpp" \
    "$SRC/CLI/src/ReplRequirer.cpp" \
    $LIBS \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createLuau -sENVIRONMENT=worker,node \
    -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=16MB -sINITIAL_MEMORY=64MB \
    -sEXPORTED_FUNCTIONS=_deobf_run,_deobf_server_start,_deobf_server_exec,_deobf_server_stop,_deobf_ast \
    -sEXPORTED_RUNTIME_METHODS=ccall,FS \
    -sFORCE_FILESYSTEM=1 -sEXIT_RUNTIME=0 \
    -o "$OUT/luau_web.mjs"
ls -la "$OUT"
