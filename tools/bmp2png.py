#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 shot.py 生成的 32 位 BMP 转成 PNG（不依赖 PIL）。"""
import struct
import sys
import zlib


def convert(src, dst, crop_bottom=0):
    with open(src, "rb") as f:
        data = f.read()
    off = struct.unpack_from("<I", data, 10)[0]
    w, h = struct.unpack_from("<ii", data, 18)
    bpp = struct.unpack_from("<H", data, 28)[0]
    assert bpp == 32, f"only 32bpp supported, got {bpp}"
    top_down = h < 0
    h_src = abs(h)
    # crop_bottom 从画面底部裁掉几行（用来去掉窗口外的桌面/任务栏杂色）
    h = max(1, h_src - max(0, crop_bottom))
    stride = w * 4

    raw = bytearray()
    rows = []
    for y in range(h):
        # BMP 默认自下而上：y=0 是最底下一行，所以要用原始高度反推
        sy = y if top_down else (h_src - 1 - y)
        base = off + sy * stride
        row = bytearray()
        row.append(0)
        for x in range(w):
            b, g, r, a = data[base + x * 4 : base + x * 4 + 4]
            row += bytes((r, g, b))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, payload):
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    with open(dst, "wb") as f:
        f.write(
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b"")
        )
    print("png saved", dst, w, "x", h)


if __name__ == "__main__":
    # 用法: bmp2png.py in.bmp out.png [裁掉底部多少像素]
    crop = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    convert(sys.argv[1], sys.argv[2], crop)
