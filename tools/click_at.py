"""在屏幕坐标处点一下（自测用）。

用法: python click_at.py X Y [按住次数]
"""
import ctypes
import sys
import time

user32 = ctypes.windll.user32
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    pass

x = int(sys.argv[1])
y = int(sys.argv[2])
n = int(sys.argv[3]) if len(sys.argv) > 3 else 1

MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004

# 连续压住光标，防止别的进程把指针抢走
user32.SetCursorPos(x, y)
for _ in range(8):
    user32.SetCursorPos(x, y)
    time.sleep(0.03)
time.sleep(0.15)
for _ in range(n):
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.30)
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    time.sleep(0.45)
print("clicked", x, y)
