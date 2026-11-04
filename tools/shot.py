#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用 Win32 GDI 截屏存为 24/32 位 BMP（不依赖 PIL）。"""
import ctypes
import ctypes.wintypes as wt
import struct
import sys

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wt.DWORD),
        ("biWidth", wt.LONG),
        ("biHeight", wt.LONG),
        ("biPlanes", wt.WORD),
        ("biBitCount", wt.WORD),
        ("biCompression", wt.DWORD),
        ("biSizeImage", wt.DWORD),
        ("biXPelsPerMeter", wt.LONG),
        ("biYPelsPerMeter", wt.LONG),
        ("biClrUsed", wt.DWORD),
        ("biClrImportant", wt.DWORD),
    ]


def shot(path, x=None, y=None, w=None, h=None):
    sw = user32.GetSystemMetrics(0)
    sh = user32.GetSystemMetrics(1)
    x = 0 if x is None else x
    y = 0 if y is None else y
    w = sw if w is None else w
    h = sh if h is None else h

    hdc = user32.GetDC(0)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(mem, bmp)
    gdi32.BitBlt(mem, 0, 0, w, h, hdc, x, y, SRCCOPY)

    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth = w
    bi.biHeight = -h  # 负数 = 自上而下
    bi.biPlanes = 1
    bi.biBitCount = 32
    bi.biCompression = 0
    bi.biSizeImage = w * h * 4

    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), DIB_RGB_COLORS)

    row = w * 4
    # 32 位 BMP：头部大小 40 + 数据，alpha 全 0 时按不透明处理
    header = struct.pack("<IiiHHIIiiII", 40, w, -h, 1, 32, 0, row * h, 2835, 2835, 0, 0)
    file_header = struct.pack("<2sIHHI", b"BM", 14 + 40 + row * h, 0, 0, 14 + 40)
    with open(path, "wb") as f:
        f.write(file_header + header + buf.raw)

    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(0, hdc)
    print("saved", path, w, "x", h)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "shot.bmp"
    if len(sys.argv) >= 6:
        shot(out, int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]))
    else:
        shot(out)
