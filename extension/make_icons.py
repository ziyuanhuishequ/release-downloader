#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从桌面版的同一套 16x16 像素画生成扩展图标（最近邻放大，硬边不模糊）"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "rust", "assets", "make_icon.py")

spec = importlib.util.spec_from_file_location("make_icon", SRC)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

ART = mod.ART
PALETTE = mod.PALETTE
GRID = mod.GRID


def render(size):
    """按像素块取色，16 的整数倍时每块大小完全一致"""
    out = []
    for y in range(size):
        sy = min(GRID - 1, y * GRID // size)
        row = []
        for x in range(size):
            sx = min(GRID - 1, x * GRID // size)
            row.append(PALETTE[ART[sy][sx]])
        out.append(row)
    return out


def main():
    try:
        from PIL import Image
    except ImportError:
        print("需要 Pillow：pip install pillow")
        return 1

    outdir = os.path.join(HERE, "icons")
    os.makedirs(outdir, exist_ok=True)
    for size in (16, 32, 48, 128):
        px = render(size)
        im = Image.new("RGBA", (size, size))
        im.putdata([tuple(px[y][x]) for y in range(size) for x in range(size)])
        path = os.path.join(outdir, f"icon{size}.png")
        im.save(path)
        print("wrote", path, im.size)

    # 宣传图：128 图标放大后放在米白底上，用于商店/README
    big = Image.open(os.path.join(outdir, "icon128.png")).resize((256, 256), Image.NEAREST)
    promo = Image.new("RGBA", (440, 280), (0xFF, 0xF3, 0xDC, 255))
    promo.paste(big, (24, 12), big)
    promo.save(os.path.join(HERE, "screenshots", "icon-promo.png"))
    print("wrote screenshots/icon-promo.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
