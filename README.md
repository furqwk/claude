# Luraph v15 Deobfuscator (web)

A static website for the deobfuscator in [`Deobfuscator/`](Deobfuscator/):
paste a Luraph v15 protected script, get readable Luau back. It runs entirely
in the browser, so it can be hosted on GitHub Pages and scripts are never
uploaded anywhere.

## How it works

The deobfuscator is dynamic: it runs the protected script in a real Luau VM
against a fake Roblox environment and lifts the VM bytecode back to Luau.
On the site:

- the Python pipeline (`Deobfuscator/deobf`) runs unchanged in
  [Pyodide](https://pyodide.org) (Python compiled to WebAssembly), loaded
  from the jsDelivr CDN;
- the `luau` / `luau-ast` programs it normally starts as processes are one
  WebAssembly module (`site/luau/luau_web.wasm`), built from the same Luau
  version (0.739) with the same Vector3 patch;
- `site/py/webdeob.py` routes the pipeline's process calls to that module;
- everything runs in a Web Worker (`site/worker.js`); the page is
  `site/index.html` + `site/app.js`.

The output is byte-for-byte the same as the native `python deobf/deob.py` run
(checked on the samples). The tool's other plugins (IronBrew 1, the generic
behaviour trace) work too.

## Publish it on GitHub Pages

1. Merge this branch into `main`.
2. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The `Deploy site to GitHub Pages` workflow publishes `site/` on every push
   to `main` (or run it by hand from the Actions tab). The site is then at
   `https://<user>.github.io/<repo>/`.

GitHub Pages needs a public repository on the free plan (private
repositories need GitHub Pro or higher). The published site, including the
bundled deobfuscator source (`deobf.zip`), is public either way.

## Develop

```sh
python build/bundle.py                   # site/deobf.zip from Deobfuscator/deobf
python -m http.server -d site 8000       # open http://localhost:8000
```

`site/luau/luau_web.{mjs,wasm}` are committed. To rebuild them (needs an
activated [Emscripten SDK](https://emscripten.org), cmake, git):

```sh
build/build_wasm.sh
```

Changes to `Deobfuscator/deobf` need no site changes: the bundle is rebuilt
on deploy. `?pyodide=<url>` on the page loads a self-hosted Pyodide instead
of the CDN copy.
