"""打包源码 zip：GitHub-Release-Downloader-Source-v<版本>.zip

只收源码、资源、文档和截图，不含 target/、测试脚本、打包产物。
"""
import json
import os
import re
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
toml = open(os.path.join(ROOT, "rust", "Cargo.toml"), encoding="utf-8").read()
VER = re.search(r'^version = "([^"]+)"', toml, re.M).group(1)
PREFIX = f"GitHub-Release-Downloader-Source-v{VER}"

INCLUDE_DIRS = [
    "rust/src",
    "rust/assets",
    "extension/src",
    "extension/icons",
    "extension/screenshots",
    "screenshots",
    "tools",
    "packaging",
    ".github",
]
INCLUDE_FILES = [
    "README.md",
    "使用说明.txt",
    "LICENSE",
    ".gitignore",
    "routes.example.txt",
    "routes.json",
    "rust/Cargo.toml",
    "rust/Cargo.lock",
    "rust/build.rs",
    "extension/manifest.json",
    "extension/README.md",
    "extension/build.py",
    "extension/make_icons.py",
]
SKIP_EXT = {".zip", ".exe", ".pyc"}
SKIP_NAME = {"icon.ico", "icon.res", "icon.rgba"}   # 图标由 make_icon.py 生成，体积大

out = os.path.join(ROOT, f"{PREFIX}.zip")
count = 0
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for f in INCLUDE_FILES:
        src = os.path.join(ROOT, f)
        if os.path.isfile(src):
            z.write(src, f"{PREFIX}/{f}")
            count += 1
    for d in INCLUDE_DIRS:
        base = os.path.join(ROOT, d)
        for cur, dirs, files in os.walk(base):
            dirs[:] = [x for x in dirs if x not in {"__pycache__", "node_modules", "target"}]
            for name in files:
                if name in SKIP_NAME:
                    continue
                if os.path.splitext(name)[1].lower() in SKIP_EXT:
                    continue
                src = os.path.join(cur, name)
                rel = os.path.relpath(src, ROOT).replace(os.sep, "/")
                z.write(src, f"{PREFIX}/{rel}")
                count += 1

size = os.path.getsize(out)
print(f"{os.path.basename(out)}  {count} 个文件  {size/1024/1024:.2f} MB")
