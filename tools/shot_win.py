#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按窗口标题截取指定窗口（Win32 GDI），用于界面自查。

用法：python shot_win.py out.bmp [--size 1150x800] [窗口标题]
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

argv = sys.argv[1:]
i = 0
first = True
while i < len(argv):
    a = argv[i]
    if a == "--size":
        size = argv[i + 1]
        i += 2
        continue
    if first:
        OUT = a
        first = False
    else:
        TITLE = a
    i += 1

hwnd = user32.FindWindowW(None, TITLE)
if not hwnd:
    print("window not found:", TITLE)
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
