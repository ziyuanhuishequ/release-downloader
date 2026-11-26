#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 extension/ 打包成可安装的压缩包

用法：python build.py
产物（输出到仓库根目录）：
  GitHub-Release-Downloader-Ext-v1.0.0-chrome.zip    Chrome / Edge / Brave / 360 / QQ
  GitHub-Release-Downloader-Ext-v1.0.0-firefox.zip   Firefox

注意：文件名保持 ASCII，GitHub Release 上传时中文名会被转义成乱码。
"""
import json
import os
import shutil
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
VER = json.load(open(os.path.join(HERE, "manifest.json"), encoding="utf-8"))["version"]
NAME = f"GitHub-Release-Downloader-Ext-v{VER}"

SKIP_DIRS = {"screenshots", "__pycache__", "node_modules", ".git"}
SKIP_FILES = {"build.py", "make_icons.py", "README.md", ".DS_Store"}


def collect():
    out = []
    for dp, dns, fns in os.walk(HERE):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for fn in fns:
            if fn in SKIP_FILES or fn.endswith((".pyc", ".zip", ".bmp")):
                continue
            full = os.path.join(dp, fn)
            rel = os.path.relpath(full, HERE).replace("\\", "/")
            out.append(rel)
    return sorted(out)


def firefox_manifest():
    m = json.load(open(os.path.join(HERE, "manifest.json"), encoding="utf-8"))
    m.pop("minimum_chrome_version", None)
    m.pop("optional_host_permissions", None)
    m["background"] = {"scripts": ["src/common.js", "src/bg.js"]}
    m["browser_specific_settings"] = {
        "gecko": {
            "id": "gh-release-helper@ziyuanhuishequ",
            "strict_min_version": "115.0"
        }
    }
    # Firefox 的 action 不接受 default_icon 里的 128 以外尺寸？实际都支持，保持原样
    return m


def write_zip(target, manifest_override=None, extra_note=None):
    names = collect()
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in names:
            data_path = os.path.join(HERE, rel)
            if rel == "manifest.json" and manifest_override:
                z.writestr(rel, json.dumps(manifest_override, ensure_ascii=False, indent=2))
            else:
                z.write(data_path, rel)
        if extra_note:
            z.writestr("安装说明.txt", extra_note)
    size = os.path.getsize(target) / 1024
    print(f"{os.path.basename(target)}  {len(names)} 文件  {size:.0f} KB")
    return target


NOTE_COMMON = """GitHub Release 下载助手（浏览器扩展）v{ver}
==========================================

纯浏览器运行，不需要安装任何桌面软件。

Chrome / Edge / Brave / 360 / QQ 浏览器（Chromium 内核）
------------------------------------------------------
1. 解压本压缩包到一个固定位置（不要解压到临时目录，删掉扩展就失效）
2. 打开 chrome://extensions （Edge 是 edge://extensions）
3. 右上角打开「开发者模式」
4. 点「加载已解压的扩展程序」，选择本压缩包解压出来的文件夹
5. 装好后右上角会出现珊瑚色图标，点它即可使用

Firefox
-------
1. 地址栏输入 about:debugging#/runtime/this-firefox
2. 点「临时载入附加组件」，选中解压目录里的 manifest.json
   （Firefox 的临时加载在重启后失效，需要长期使用请用开发者版签名，或用 Chrome/Edge）

怎么用
------
方式一：打开任意 GitHub 的 Release 页面，右下角会出现下载面板，
        勾选要的文件，点「下载 N 个文件」。
方式二：点扩展图标，粘贴 owner/repo（例如 sharkdp/bat），扫描后勾选下载。

下载的文件会存到「下载/GitHub/仓库名/版本号/」下，可在设置里关掉归档。
扩展会自动测试 20 条加速线路，挑最快的一条；下载中断会自动换线路重试。

常见问题
--------
· 403 或「请求太频繁」：GitHub 匿名接口每小时 60 次。到设置里填一个
  Personal Access Token 即可提到 5000 次/小时，也能读私有仓库。
· 某个线路下载下来是网页而不是文件：扩展在下载前会先探一字节校验，
  发现不对自动换线，不会把错误页存成文件。
· 想要更多线路：设置页「线路」里一行一条追加，格式 名称|https://前缀/
"""


def main():
    chrome_note = NOTE_COMMON.format(ver=VER)
    c = write_zip(os.path.join(ROOT, f"{NAME}-chrome.zip"), None, chrome_note)
    f = write_zip(os.path.join(ROOT, f"{NAME}-firefox.zip"), firefox_manifest(),
                  chrome_note.replace("Chrome / Edge / Brave / 360 / QQ 浏览器（Chromium 内核）\n------------------------------------------------------\n",
                                      "【本包为 Firefox 版】\n\nChrome / Edge / Brave / 360 / QQ 浏览器（Chromium 内核）\n------------------------------------------------------\n"))
    # 免解压直接用：生成一个解压好的目录，方便「加载已解压的扩展程序」直接选
    out_dir = os.path.join(ROOT, "浏览器扩展")
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir, ignore_errors=True)
    shutil.copytree(HERE, out_dir, ignore=shutil.ignore_patterns(
        "screenshots", "__pycache__", "build.py", "make_icons.py", "README.md", "*.zip"))
    open(os.path.join(out_dir, "安装说明.txt"), "w", encoding="utf-8", newline="\r\n").write(chrome_note)
    print("目录：浏览器扩展/")
    return c, f


if __name__ == "__main__":
    main()
