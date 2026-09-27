// Synchronous bridge between the Python pipeline (webdeob.py, via Pyodide)
// and the Luau WebAssembly module (luau/luau_web.mjs). ES module, imported
// by worker.js (and by Node for testing).
//
// Every call returns { rc, out, err } with out/err as Uint8Array (raw bytes:
// the harness prints NUL bytes and latin-1 text).
export function makeLuauBridge(M) {
  const FS = M.FS;
  const read = (p) => { try { return FS.readFile(p); } catch (e) { return new Uint8Array(0); } };
  const mkdirs = (dir) => {
    let cur = "";
    for (const part of dir.split("/").filter(Boolean)) {
      cur += "/" + part;
      try { FS.mkdir(cur); } catch (e) { /* exists */ }
    }
  };
  const write = (path, bytes) => {
    mkdirs(path.slice(0, path.lastIndexOf("/")) || "/");
    FS.writeFile(path, bytes);
  };
  mkdirs("/io");
  const result = (rc) => ({ rc, out: read("/io/out"), err: read("/io/err") });

  return {
    // `luau <path>`: the file is written at the same path the Python side
    // uses, so error messages name it the way harness.run_once expects
    runFile(path, bytes, timeout, stall) {
      write(path, bytes);
      const rc = M.ccall("deobf_run", "number", ["string", "number", "number"], [path, timeout, stall]);
      try { FS.unlink(path); } catch (e) { /* gone */ }
      return result(rc);
    },
    // `luau-ast <file>`
    ast(bytes) {
      write("/ast/input.luau", bytes);
      return result(M.ccall("deobf_ast", "number", ["string"], ["/ast/input.luau"]));
    },
    // `luau` REPL in `dir`, with harness.luau there
    serverStart(dir, harnessBytes) {
      write(dir + "/harness.luau", harnessBytes);
      M.ccall("deobf_server_start", "number", ["string"], [dir]);
    },
    serverExec(line, timeout) {
      return result(M.ccall("deobf_server_exec", "number", ["string", "number"], [line, timeout]));
    },
    serverStop() {
      M.ccall("deobf_server_stop", null, [], []);
    },
    writeFile(path, bytes) {
      write(path, bytes);
    },
  };
}
