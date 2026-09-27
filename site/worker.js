// Background module worker: hosts Pyodide (the Python deobfuscator) and the Luau
// WebAssembly runtime, so the page stays responsive during a run.
//
// Messages in:  { type: "run", source: Uint8Array, options: string[] }
// Messages out: { type: "status", text } | { type: "log", text }
//               { type: "ready" } | { type: "done", code, text, ms }
//               { type: "error", text }
import createLuau from "./luau/luau_web.mjs";
import { makeLuauBridge } from "./luau-bridge.js";

const PYODIDE_VERSION = "314.0.7";
// `?pyodide=<base url>` on the page (forwarded here) loads a self-hosted copy
const PYODIDE_URL = new URLSearchParams(self.location.search).get("pyodide") ||
  `https://cdn.jsdelivr.net/npm/pyodide@${PYODIDE_VERSION}/`;


const post = (msg) => self.postMessage(msg);
let py = null;
let webdeob = null;
let wasmModule = null;

async function init() {
  post({ type: "status", text: "Downloading Python runtime…" });
  const { loadPyodide } = await import(PYODIDE_URL + "pyodide.mjs");
  const log = (text) => post({ type: "log", text });
  const [pyodide, zip, wasm] = await Promise.all([
    loadPyodide({ indexURL: PYODIDE_URL, stdout: log, stderr: log }),
    fetch("deobf.zip").then((r) => {
      if (!r.ok) throw new Error("deobf.zip: HTTP " + r.status);
      return r.arrayBuffer();
    }),
    WebAssembly.compileStreaming(fetch("luau/luau_web.wasm")).catch(async () =>
      WebAssembly.compile(await (await fetch("luau/luau_web.wasm")).arrayBuffer())
    ),
  ]);
  py = pyodide;
  wasmModule = wasm;
  post({ type: "status", text: "Unpacking deobfuscator…" });
  py.unpackArchive(new Uint8Array(zip), "zip", { extractDir: "/app" });
  py.runPython('import sys; sys.path.insert(0, "/app")');
  webdeob = py.pyimport("webdeob");
  post({ type: "ready" });
}

// A fresh Luau instance per job: like the native pipeline's fresh processes,
// nothing (e.g. a state abandoned after a timeout) carries over.
function newLuau() {
  return createLuau({
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(wasmModule, imports).then((inst) => done(inst, wasmModule));
      return {};
    },
    print: () => {},
    printErr: () => {},
  });
}

const initPromise = init().catch((e) => post({ type: "error", text: "Failed to start: " + (e && e.message || e) }));

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type !== "run") return;
  await initPromise;
  if (!webdeob) return;
  try {
    self.luauBridge = makeLuauBridge(await newLuau());
    const t0 = performance.now();
    const res = webdeob.run(msg.source, py.toPy(msg.options || []));
    const [code, text] = res.toJs();
    res.destroy();
    post({ type: "done", code, text, ms: performance.now() - t0 });
  } catch (e) {
    post({ type: "error", text: String(e && e.message || e) });
  } finally {
    self.luauBridge = null;
  }
};
