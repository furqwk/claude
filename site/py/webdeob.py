"""
Runs deobf/deob.py inside Pyodide (a browser worker).

The pipeline normally starts `luau` / `luau-ast` processes. Here those are
one WebAssembly module (site/luau/luau_web.wasm, built from the same Luau
version with the same patch), called synchronously through the JavaScript
bridge in luau-bridge.js (the global `luauBridge`). This module swaps the
process-based pieces for bridge calls and leaves the pipeline itself as is:

- subprocess.run([.../luau-ast, file])     -> luauBridge.ast(bytes)
- harness._communicate([luau, harness])    -> luauBridge.runFile(...)
- harness.HarnessServer (REPL over stdin)  -> WebHarnessServer (bridge REPL)
- backend.run_big_stack (thread)           -> a plain call (no threads here)

`run(source, options)` deobfuscates one script and returns (exit code, text).
Every run re-imports the deobf modules: they keep global state between runs
(Path2D cache, LAST_RAW), which the native pipeline avoids by using one
process per script.
"""
import os
import re
import shutil
import subprocess
import sys
import time
import warnings

import js
from pyodide.ffi import to_js

HERE = os.path.dirname(os.path.abspath(__file__))
DEOBF = os.path.join(HERE, "deobf")
WORK = "/work"
_real_run = subprocess.run


def _bytes(jsbuf):
    return bytes(jsbuf.to_py()) if jsbuf is not None else b""


def _fake_run(cmd, *a, **kw):
    """subprocess.run for luau-ast (names.py, localfuncs.py, luauast.py, vmmap.py)."""
    if isinstance(cmd, (list, tuple)) and cmd and os.path.basename(str(cmd[0])).startswith("luau-ast"):
        with open(cmd[1], "rb") as f:
            data = f.read()
        res = js.luauBridge.ast(to_js(data))
        out, err, rc = _bytes(res.out), _bytes(res.err), int(res.rc)
        if kw.get("check") and rc != 0:
            raise subprocess.CalledProcessError(rc, cmd, out, err)
        return subprocess.CompletedProcess(cmd, rc, out, err)
    raise OSError("no processes in the browser: %r" % (cmd,))


def _communicate(cmd, timeout, stall):
    """harness._communicate: one `luau <harness>` run."""
    path = cmd[1]
    with open(path, "rb") as f:
        data = f.read()
    res = js.luauBridge.runFile(path, to_js(data), float(timeout), float(stall or 0))
    if int(res.rc) == 2:
        raise subprocess.TimeoutExpired(cmd, timeout)
    return _bytes(res.out), _bytes(res.err)


def _patch():
    import backend
    import harness

    def run_big_stack(fn, *a):
        # Pyodide's Python calls don't use the C stack: no thread needed
        sys.setrecursionlimit(200000)
        return fn(*a)

    backend.run_big_stack = run_big_stack
    harness.find_luau = lambda: "luau"
    harness._communicate = _communicate

    class WebHarnessServer(harness.HarnessServer):
        """HarnessServer over the bridge's REPL: lines are queued by _send and
        executed by reply(), under the reply's deadline."""
        _count = [0]

        def __init__(self, luau, source, cfg, chunks):
            WebHarnessServer._count[0] += 1
            self.dir = "/srv%d" % WebHarnessServer._count[0]
            text = harness.build_harness(source, dict(cfg, serve=True), chunks)
            js.luauBridge.serverStart(self.dir, to_js(text.encode("latin-1")))
            self.buf = b""
            self.queue = []
            self.dead = False
            self.timed_out = False
            self.nreq = 0
            self._send(b'__S = require("./harness")\n__S("", "", "start")\n')

        def _send(self, line):
            self.queue += [ln for ln in line.decode("latin-1").split("\n") if ln]

        def reply(self, timeout):
            deadline = time.time() + timeout
            while self.queue and not self.dead:
                line = self.queue.pop(0)
                res = js.luauBridge.serverExec(line, max(0.01, deadline - time.time()))
                self.buf += _bytes(res.out)
                if int(res.rc) == 2:
                    self.dead = self.timed_out = True
            self.queue = []
            if self.END not in self.buf:
                out = self.buf.decode("utf-8", "replace")
                self.close()
                return None, ("no reply within %ds" % timeout if self.timed_out else
                              "harness process exited") + ": " + out[-3000:]
            i = self.buf.index(self.END) + len(self.END)
            out, self.buf = self.buf[:i], self.buf[i:]
            out = out.decode("utf-8", "replace").replace("\r\n", "\n")
            harness.LAST_RAW[0] = out
            m = re.search(r"\x00ENVLOG-BEGIN\n(.*?)\x00ENVLOG-END", out, re.S)
            if not m:
                return None, out[-3000:]
            return m.group(1), None

        def request(self, cfg, timeout, mode="dump"):
            req, buf = cfg.get("force_req") or "", cfg.get("force_buf") or ""
            if len(req) + len(buf) < 2000 and re.fullmatch(r"[\w,@.;=+/:*\-]*", req + buf):
                self._send(('__S("%s", "%s", "%s")\n' % (req, buf, mode)).encode())
                return self.reply(timeout)
            self.nreq += 1
            name = "req_%d" % self.nreq
            body = "return {%s, %s, %s}\n" % (harness.long_string(req), harness.long_string(buf),
                                              harness.long_string(mode))
            js.luauBridge.writeFile(self.dir + "/" + name + ".luau", to_js(body.encode("utf-8")))
            self._send(b'__S(table.unpack(require("./%s")))\n' % name.encode())
            return self.reply(timeout)

        def close(self):
            if not self.dead:
                js.luauBridge.serverStop()
            self.dead = True

    harness.HarnessServer = WebHarnessServer


def _fresh_modules():
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None) or ""
        if f.startswith(DEOBF):
            del sys.modules[name]


def run(source, options=()):
    """Deobfuscate `source` (bytes, str or a JS Uint8Array). Returns (exit
    code, result text)."""
    if hasattr(source, "to_py"):
        source = bytes(source.to_py())
    elif isinstance(source, str):
        source = source.encode("utf-8")
    options = [str(o) for o in (options.to_py() if hasattr(options, "to_py") else options)]
    warnings.simplefilter("ignore", SyntaxWarning)
    if DEOBF not in sys.path:
        sys.path.insert(0, DEOBF)
    subprocess.run = _fake_run
    _fresh_modules()
    _patch()
    import deob
    deob.maybe_reexec_pypy = lambda args: None

    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK)
    inp = os.path.join(WORK, "script.lua")
    out = os.path.join(WORK, "result.lua")
    with open(inp, "wb") as f:
        f.write(source)
    sys.argv = ["deob.py", inp, "-o", out] + list(options)
    code = 0
    try:
        deob.main()
    except SystemExit as e:
        if isinstance(e.code, str):
            print(e.code, file=sys.stderr)
            code = 1
        else:
            code = e.code or 0
    if "--detect" in options:
        return code, ""
    if not os.path.exists(out):
        return code or 1, ""
    with open(out, "rb") as f:
        return code, f.read().decode("utf-8", "replace")
