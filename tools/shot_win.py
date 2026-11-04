#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按窗口标题（或进程 PID）截取指定窗口（Win32 GDI），用于界面自查。

用法：
    python shot_win.py out.bmp [--size 1150x800] [窗口标题]
    python shot_win.py out.bmp --pid 12345 [--size 1150x800]
"""
import ctypes
import ctypes.wintypes as wt
import sys

sys.path.insert(0, ".")
from shot import shot  # noqa: E402

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

OUT = "win.bmp"
TITLE = "GitHub Release 下载整理工具"
size = None
pid = None

argv = sys.argv[1:]
i = 0
first = True
while i < len(argv):
    a = argv[i]
    if a == "--size":
        size = argv[i + 1]
        i += 2
        continue
    if a == "--pid":
        pid = int(argv[i + 1])
        i += 2
        continue
    if first:
        OUT = a
        first = False
    else:
        TITLE = a
    i += 1


def by_pid(target):
    """同名的窗口可能有多个（用户自己开着一个，自测又开一个），按 PID 精确找。"""
    found = []
    CB = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        p = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if p.value == target and user32.GetWindowTextLengthW(hwnd) > 0:
            found.append(hwnd)
        return True

    user32.EnumWindows(CB(cb), 0)
    return found[0] if found else 0


if pid:
    hwnd = by_pid(pid)
else:
    hwnd = user32.FindWindowW(None, TITLE)

if not hwnd:
    print("window not found:", pid or TITLE)
    sys.exit(1)

user32.ShowWindow(hwnd, 9)  # SW_RESTORE

if size:
    w, h = [int(x) for x in size.lower().split("x")]
    user32.MoveWindow(hwnd, 90, 90, w, h, True)
    kernel32.Sleep(500)

for _ in range(20):
    user32.SetForegroundWindow(hwnd)
    kernel32.Sleep(50)
    if user32.GetForegroundWindow() == hwnd:
        break

r = wt.RECT()
user32.GetWindowRect(hwnd, ctypes.byref(r))
w, h = r.right - r.left, r.bottom - r.top
print("rect", r.left, r.top, w, h)
shot(OUT, r.left, r.top, w, h)
