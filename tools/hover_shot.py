#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""悬停 + 截图：本机有其他软件会抢鼠标，所以要在循环里反复把光标压回目标点再截图。

用法：python hover_shot.py out.bmp X Y [hold秒]
X Y 是相对窗口左上角的坐标
"""
import ctypes
import ctypes.wintypes as wt
import sys
import time

sys.path.insert(0, ".")
from shot import shot  # noqa: E402

TITLE = "GitHub Release 下载整理工具"
user32 = ctypes.windll.user32
user32.SetProcessDPIAware()
user32.FindWindowW.restype = ctypes.c_void_p

OUT = sys.argv[1] if len(sys.argv) > 1 else "hover.bmp"
DX = int(sys.argv[2]) if len(sys.argv) > 2 else 200
DY = int(sys.argv[3]) if len(sys.argv) > 3 else 257
HOLD = float(sys.argv[4]) if len(sys.argv) > 4 else 2.0

hwnd = user32.FindWindowW(None, TITLE)
if not hwnd:
    print("window not found")
    sys.exit(1)
user32.ShowWindow(hwnd, 9)
for _ in range(30):
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.05)
    if user32.GetForegroundWindow() == hwnd:
        break

r = wt.RECT()
user32.GetWindowRect(hwnd, ctypes.byref(r))
x, y = r.left + DX, r.top + DY
print("window", r.left, r.top, "target", x, y)

deadline = time.time() + HOLD
while time.time() < deadline:
    user32.SetCursorPos(x, y)
    time.sleep(0.04)

# 最后一刻压住光标并立刻抓屏
user32.SetCursorPos(x, y)
pos = wt.POINT()
user32.GetCursorPos(ctypes.byref(pos))
print("cursor at", pos.x, pos.y)
w, h = r.right - r.left, r.bottom - r.top
shot(OUT, r.left, r.top, w, h)
print("saved", OUT, w, h)
