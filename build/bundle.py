"""
Packs the deobfuscator for the site: site/deobf.zip holds deobf/ (the
pipeline's Python and Luau files, from Deobfuscator/deobf) and webdeob.py.
The worker unpacks it into Pyodide's file system.
    python build/bundle.py
"""
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "Deobfuscator", "deobf")
SITE = os.path.join(ROOT, "site")
SKIP_DIRS = {"__pycache__", "research", "bin", "probes"}


def main():
    out = os.path.join(SITE, "deobf.zip")
    n = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for dirpath, dirnames, filenames in os.walk(SRC):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
            for name in sorted(filenames):
                if name.endswith((".py", ".luau")):
                    path = os.path.join(dirpath, name)
                    z.write(path, os.path.join("deobf", os.path.relpath(path, SRC)))
                    n += 1
        z.write(os.path.join(SITE, "py", "webdeob.py"), "webdeob.py")
    print("wrote %s (%d files, %d KB)" % (out, n + 1, os.path.getsize(out) // 1024))


if __name__ == "__main__":
    main()
