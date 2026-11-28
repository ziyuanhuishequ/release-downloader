"""用 GitHub REST API 发 Release 并上传附件（本机 git 协议被墙时用）。

用法：python _api_release.py <tag> <标题> <说明文件.md> <附件1> [附件2 ...]
"""
import json
import mimetypes
import os
import subprocess
import sys
import urllib.error
import urllib.request

REPO = "ziyuanhuishequ/release-downloader"
API = f"https://api.github.com/repos/{REPO}"
TOKEN = subprocess.run(
    ["bash", "-lc", "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p'"],
    capture_output=True, text=True, check=True,
).stdout.strip()
assert TOKEN, "拿不到 token"


def call(method, url, payload=None, raw=None, ctype=None):
    body = raw if raw is not None else (json.dumps(payload).encode() if payload is not None else None)
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Accept", "application/vnd.github+json")
    if body is not None:
        req.add_header("Content-Type", ctype or "application/json")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            data = r.read()
            return json.loads(data) if data else {}
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode()[:800])
        raise


tag, title, bodyfile = sys.argv[1], sys.argv[2], sys.argv[3]
assets = sys.argv[4:]

body = open(bodyfile, encoding="utf-8").read()

# 已存在就复用，避免重复点的时候报 422
try:
    rel = call("GET", f"{API}/releases/tags/{tag}")
    print("Release 已存在:", rel["html_url"])
except urllib.error.HTTPError:
    rel = call("POST", f"{API}/releases", {
        "tag_name": tag,
        "target_commitish": "main",
        "name": title,
        "body": body,
        "draft": False,
        "prerelease": False,
    })
    print("Release 已创建:", rel["html_url"])

have = {a["name"]: a["id"] for a in rel.get("assets", [])}
upload_base = rel["upload_url"].split("{")[0]

for path in assets:
    name = os.path.basename(path)
    if name in have:
        print("  跳过（已存在）", name)
        continue
    ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    data = open(path, "rb").read()
    res = call("POST", f"{upload_base}?name={urllib.parse.quote(name)}", raw=data, ctype=ctype)
    print(f"  上传 {name}  {len(data)/1024:.0f} KB  → {res.get('state')}")

print("完成:", rel["html_url"])
