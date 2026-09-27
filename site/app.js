// Page logic: collects the script and options, runs them in worker.js and
// shows the result. Cancel terminates the worker and starts a new one.
(() => {
  const $ = (id) => document.getElementById(id);
  const input = $("input"), output = $("output"), logEl = $("log");
  const btnRun = $("btnRun"), btnCancel = $("btnCancel");
  const btnCopy = $("btnCopy"), btnDownload = $("btnDownload");
  const statusEl = $("status"), engine = $("engine"), engineText = $("engineText");

  let worker = null;
  let ready = false;
  let busy = false;
  let timer = null;
  let started = 0;
  let logLines = 0;
  let resultName = "deobfuscated.lua";

  const fmtBytes = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(2) + " MB";
  const fmtTime = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s"; };

  function setEngine(state, text) {
    engine.dataset.state = state;
    engineText.textContent = text;
  }
  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = "status" + (cls ? " " + cls : "");
  }
  function appendLog(text) {
    logLines++;
    logEl.textContent += text.replace(/\x00/g, "") + "\n";
    logEl.scrollTop = logEl.scrollHeight;
    $("logCount").textContent = "(" + logLines + ")";
    // live progress line under the button
    const m = text.match(/^\[\*\]\s*(.+)/);
    if (busy && m) setStatus(m[1].slice(0, 120) + " · " + fmtTime(performance.now() - started));
  }
  function updateButtons() {
    btnRun.disabled = !ready || busy || !input.value.trim();
    btnCancel.hidden = !busy;
    btnCopy.disabled = btnDownload.disabled = !output.value;
  }
  function updateInMeta() {
    const bytes = new TextEncoder().encode(input.value).length;
    const header = /Luraph Obfuscator v15/.test(input.value.slice(0, 400)) ? " · Luraph v15 header found" : "";
    $("inMeta").textContent = fmtBytes(bytes) + header;
    updateButtons();
  }

  function startWorker() {
    ready = false;
    setEngine("loading", "Starting engine…");
    const pyo = new URLSearchParams(location.search).get("pyodide");
    worker = new Worker("worker.js" + (pyo ? "?pyodide=" + encodeURIComponent(pyo) : ""), { type: "module" });
    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === "status") setEngine("loading", msg.text);
      else if (msg.type === "ready") { ready = true; setEngine("ready", "Engine ready"); updateButtons(); }
      else if (msg.type === "log") appendLog(msg.text);
      else if (msg.type === "done") finish(msg);
      else if (msg.type === "error") fail(msg.text);
    };
    worker.onerror = (e) => fail(e.message || "worker error");
  }

  function finish(msg) {
    busy = false;
    clearInterval(timer);
    setEngine("ready", "Engine ready");
    output.value = msg.text || "";
    const lines = output.value ? output.value.split("\n").length : 0;
    $("outMeta").textContent = output.value ? `${lines.toLocaleString()} lines · ${fmtBytes(new TextEncoder().encode(output.value).length)}` : "";
    if (msg.code === 0 && output.value) {
      const kind = /^-- Detected obfuscation: (.+)$/m.exec(output.value);
      setStatus(`Done in ${fmtTime(msg.ms)}` + (kind ? ` · ${kind[1]}` : ""), "ok");
    } else {
      setStatus(`Failed after ${fmtTime(msg.ms)}: see the log`, "err");
      $("logBox").open = true;
    }
    updateButtons();
  }

  function fail(text) {
    busy = false;
    clearInterval(timer);
    appendLog("[!] " + text);
    setStatus(text.slice(0, 200), "err");
    setEngine(ready ? "ready" : "error", ready ? "Engine ready" : "Engine failed to start");
    $("logBox").open = true;
    updateButtons();
  }

  // shell-like split of the advanced arguments (quotes group words)
  function splitArgs(s) {
    const out = [];
    const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
    let m;
    let cur = null;
    let lastEnd = -1;
    while ((m = re.exec(s))) {
      const piece = m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] !== undefined ? m[2] : m[3];
      if (cur !== null && m.index === lastEnd) cur += piece; // e.g. prelude="a b"
      else { if (cur !== null) out.push(cur); cur = piece; }
      lastEnd = re.lastIndex;
    }
    if (cur !== null) out.push(cur);
    return out;
  }

  function run() {
    if (!ready || busy || !input.value.trim()) return;
    const options = [];
    if (document.querySelector('input[name="mode"]:checked').value === "trace") options.push("--no-devirt");
    const obf = $("obfuscator").value;
    if (obf) options.push("--obfuscator", obf);
    const timeout = parseInt($("timeout").value, 10);
    if (timeout > 0) options.push("--timeout", String(timeout));
    options.push(...splitArgs($("extra").value));

    busy = true;
    started = performance.now();
    output.value = "";
    $("outMeta").textContent = "";
    logEl.textContent = "";
    logLines = 0;
    $("logCount").textContent = "";
    setEngine("busy", "Working…");
    setStatus("Starting…");
    timer = setInterval(() => {
      const t = fmtTime(performance.now() - started);
      statusEl.textContent = statusEl.textContent.replace(/( · \d+m? ?\d*s)?$/, " · " + t);
    }, 1000);
    updateButtons();
    worker.postMessage({ type: "run", source: new TextEncoder().encode(input.value), options });
  }

  function cancel() {
    if (!busy) return;
    worker.terminate();
    busy = false;
    clearInterval(timer);
    setStatus("Cancelled", "err");
    appendLog("[!] cancelled");
    updateButtons();
    startWorker();
  }

  async function loadFile(file) {
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    // latin-1 fallback keeps every byte if the file isn't valid UTF-8
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch { text = new TextDecoder("latin1").decode(buf); }
    input.value = text;
    resultName = file.name.replace(/(\.luau?|\.txt)?$/i, "") + ".deobf.lua";
    updateInMeta();
  }

  btnRun.addEventListener("click", run);
  btnCancel.addEventListener("click", cancel);
  input.addEventListener("input", updateInMeta);
  input.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); }
  });
  $("btnClear").addEventListener("click", () => { input.value = ""; resultName = "deobfuscated.lua"; updateInMeta(); input.focus(); });
  $("fileInput").addEventListener("change", (e) => { loadFile(e.target.files[0]); e.target.value = ""; });
  $("btnSample").addEventListener("click", async () => {
    setStatus("Loading sample…");
    try {
      const r = await fetch("sample.lua");
      input.value = await r.text();
      resultName = "sample.deobf.lua";
      setStatus("Sample loaded (a Luraph v15 protected stack machine)");
    } catch (e) { setStatus("Could not load the sample", "err"); }
    updateInMeta();
  });
  btnCopy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(output.value); }
    catch { output.select(); document.execCommand("copy"); }
    btnCopy.textContent = "Copied";
    setTimeout(() => (btnCopy.textContent = "Copy"), 1200);
  });
  btnDownload.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([output.value], { type: "text/plain;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: resultName });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // drag and drop anywhere on the page
  const drop = $("drop");
  let depth = 0;
  window.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types?.includes("Files")) { depth++; drop.hidden = false; } });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; drop.hidden = true; } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    drop.hidden = true;
    loadFile(e.dataTransfer.files[0]);
  });

  startWorker();
  updateInMeta();
})();
