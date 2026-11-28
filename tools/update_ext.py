#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键更新浏览器扩展：下载最新包 → 直接覆盖到扩展目录，不用手动解压。

用法：
    python tools/update_ext.py --dir "D:/浏览器扩展/GitHub-Release-Downloader"
    python tools/update_ext.py            # 第一次会让你输入目录，之后记在脚本旁边
    python tools/update_ext.py --check    # 只查版本，不下载
    python tools/update_ext.py --firefox  # 装的是 Firefox 版

为什么需要它：Chrome 只能「加载已解压的扩展程序」，直接拖 zip 是不认的。
Chrome 应用商店在国内又打不开，所以给一个把「下载 + 解压 + 覆盖」合成一步的小脚本。
更新完只要到 chrome://extensions 点一下扩展卡片上的刷新按钮，设置和线路历史都保留。
"""
import argparse
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.request
import zipfile

REPO = "ziyuanhuishequ/release-downloader"
API_CHANNELS = [
    "https://api.github.com",
    "https://gh-proxy.org/https://api.github.com",
    "https://gh-proxy.com/https://api.github.com",
]
DL_CHANNELS = [
    "",
    "https://gh-proxy.org/",
    "https://gh-proxy.com/",
]
HERE = os.path.dirname(os.path.abspath(__file__))
CONF = os.path.join(HERE, ".update_ext.json")
UA = "GitHubReleaseDownloader-Updater/1.0"


def http_get(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def api(path):
    last = None
    for base in API_CHANNELS:
        try:
            return json.loads(http_get(base + path).decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            last = exc
    raise RuntimeError(f"连不上 GitHub API：{last}")


def ver_tuple(tag):
    nums = re.findall(r"\d+", tag)
    return tuple(int(x) for x in nums[:3]) if nums else (0, 0, 0)


def latest_ext_release():
    """扩展的每个版本都是独立的 ext-vX.Y.Z Release，取版本号最大的那个。"""
    rels = api(f"/repos/{REPO}/releases?per_page=50")
    best = None
    for r in rels:
        tag = r.get("tag_name", "")
        if not tag.startswith("ext-v"):
            continue
        if best is None or ver_tuple(tag) > ver_tuple(best["tag_name"]):
            best = r
    if not best:
        raise RuntimeError("没有找到扩展的 Release（tag 应该是 ext-vX.Y.Z）")
    return best


def pick_asset(rel, firefox):
    want = "-firefox.zip" if firefox else "-chrome.zip"
    for a in rel.get("assets", []):
        if a["name"].endswith(want):
            return a
    raise RuntimeError(f"{rel['tag_name']} 里没有 {want} 附件")


def download(url):
    last = None
    for prefix in DL_CHANNELS:
        try:
            data = http_get(prefix + url, timeout=180)
            if len(data) < 10_000:
                raise RuntimeError(f"下载到的文件只有 {len(data)} 字节，八成是错误页")
            return data
        except Exception as exc:  # noqa: BLE001
            last = exc
    raise RuntimeError(f"下载失败：{last}")


def load_conf():
    try:
        return json.load(open(CONF, encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def save_conf(c):
    try:
        json.dump(c, open(CONF, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    except Exception:  # noqa: BLE001
        pass


def find_installed_dir():
    """常见位置猜一把：Chrome 的扩展加载路径不会写在注册表里，只能按名字找。"""
    home = os.path.expanduser("~")
    guesses = []
    for root in (os.path.join(home, "Downloads"), os.path.join(home, "Desktop"), home):
        if not os.path.isdir(root):
            continue
        for name in os.listdir(root):
            p = os.path.join(root, name)
            if os.path.isdir(p) and os.path.isfile(os.path.join(p, "manifest.json")) and "GitHub-Release" in name:
                guesses.append(p)
    return guesses[0] if guesses else ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", help="扩展解压后的目录（含 manifest.json 的那一层）")
    ap.add_argument("--firefox", action="store_true", help="更新 Firefox 版")
    ap.add_argument("--check", action="store_true", help="只看版本，不下载")
    ap.add_argument("--yes", action="store_true", help="不询问，直接覆盖")
    args = ap.parse_args()

    conf = load_conf()
    rel = latest_ext_release()
    asset = pick_asset(rel, args.firefox)
    print(f"最新扩展：{rel['tag_name']}  （{asset['name']}，{asset['size'] / 1024:.0f} KB）")

    target = args.dir or conf.get("dir") or find_installed_dir()
    if not target and not args.check:
        print("没找到已经装好的扩展目录，请把它拖进来（含 manifest.json 的文件夹）：")
        target = input("路径：").strip().strip('"')
    if target:
        target = os.path.abspath(target)
        cur = ""
        mf = os.path.join(target, "manifest.json")
        if os.path.isfile(mf):
            try:
                cur = json.load(open(mf, encoding="utf-8")).get("version", "")
            except Exception:  # noqa: BLE001
                cur = ""
        print(f"安装目录：{target}")
        print(f"当前版本：{cur or '未知'}")
        if cur and ver_tuple(cur) >= ver_tuple(rel["tag_name"].replace("ext-v", "")):
            print("已经是最新版了，不用更新。")
            if not args.check:
                save_conf({"dir": target})
                return 0
        if args.check:
            return 0
        if not args.yes:
            ans = input("把上面的目录覆盖成最新版？原来的配置（浏览器里的设置）不会动 [y/N] ").strip().lower()
            if ans not in ("y", "yes", "是"):
                print("已取消。")
                return 1
    elif args.check:
        return 0

    print("下载中…")
    data = download(asset["browser_download_url"])
    tmp = os.path.join(HERE, "_ext_update.zip")
    with open(tmp, "wb") as f:
        f.write(data)

    if not os.path.isdir(target):
        os.makedirs(target, exist_ok=True)
    with zipfile.ZipFile(tmp) as z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        # 老版本里可能有、新版本删掉的文件：先清掉 src/ 和 icons/ 再解压，避免残留旧脚本
        for sub in ("src", "icons"):
            p = os.path.join(target, sub)
            if os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)
        z.extractall(target)
    os.remove(tmp)

    save_conf({"dir": target})
    print(f"已更新 {len(names)} 个文件到 {target}")
    print("最后一步：打开 chrome://extensions（Edge 是 edge://extensions），")
    print("在扩展卡片上点一下刷新按钮（↻）即可，设置、下载记录、线路历史都会保留。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
