#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成像素风应用图标：icon.rgba(窗口图标) / icon.ico(文件图标) / icon.res(链接用资源)"""
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
SIZES = [16, 24, 32, 48, 64, 128, 256]

# 16x16 像素画：K=墨线 C=米白 O=珊瑚 L=浅珊瑚 M=薄荷 .=透明
# 下箭头保持 8x8 的正方形比例（杆 4 宽 3 高 + 三角 4 行），避免拉长变形
ART = [
    "KKKKKKKKKKKKKKKK",
    "KCCCCCCCCCCCCCCK",
    "KCCCCCOOOOCCCCCK",
    "KCCCCCOOOOCCCCCK",
    "KCCCCCOOOOCCCCCK",
    "KCCCCCOOOOCCCCCK",
    "KCCOOOOOOOOOOCCK",
    "KCCOOOOOOOOOOCCK",
    "KCCCOOOOOOOOCCCK",
    "KCCCCOOOOOOCCCCK",
    "KCCCCCOOOOCCCCCK",
    "KCCCCCCOOCCCCCCK",
    "KCCCCCCCCCCCCCCK",
    "KCCMMMMMMMMMMCCK",
    "KCCMMMMMMMMMMCCK",
    "KKKKKKKKKKKKKKKK",
]

PALETTE = {
    "K": (0x1A, 0x1E, 0x30, 255),  # 墨蓝描边
    "C": (0xFF, 0xF3, 0xDC, 255),  # 米白底
    "O": (0xFF, 0x6A, 0x3D, 255),  # 珊瑚
    "L": (0xFF, 0x9A, 0x72, 255),  # 高光珊瑚
    "M": (0x2E, 0xD3, 0xA5, 255),  # 薄荷
    ".": (0, 0, 0, 0),
}

GRID = 16
assert len(ART) == GRID and all(len(r) == GRID for r in ART), "像素画必须是 16x16"


def render(size):
    """最近邻放大，保持硬边（不超采样、不插值）"""
    px = []
    for y in range(size):
        sy = min(GRID - 1, y * GRID // size)
        row = []
        for x in range(size):
            sx = min(GRID - 1, x * GRID // size)
            ch = ART[sy][sx]
            r, g, b, a = PALETTE[ch]
            row.append((r / 255.0, g / 255.0, b / 255.0, a / 255.0))
        px.append(row)
    return px


def to_bytes(px, size):
    buf = bytearray()
    for y in range(size):
        for x in range(size):
            r, g, b, a = px[y][x]
            buf += bytes(
                (
                    int(r * 255 + 0.5),
                    int(g * 255 + 0.5),
                    int(b * 255 + 0.5),
                    int(a * 255 + 0.5),
                )
            )
    return bytes(buf)


def dib(px, size):
    """生成 ICO 内的 32bpp BMP（含 AND 掩码）"""
    header = struct.pack(
        "<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, size * size * 4, 0, 0, 0, 0
    )
    pixels = bytearray()
    for y in range(size - 1, -1, -1):
        for x in range(size):
            r, g, b, a = px[y][x]
            pixels += bytes(
                (
                    int(b * 255 + 0.5),
                    int(g * 255 + 0.5),
                    int(r * 255 + 0.5),
                    int(a * 255 + 0.5),
                )
            )
    row_bytes = ((size + 31) // 32) * 4
    mask = b"\x00" * (row_bytes * size)
    return header + bytes(pixels) + mask


def write_ico(images, path):
    count = len(images)
    offset = 6 + 16 * count
    entries = b""
    blobs = b""
    for size, data in images:
        entries += struct.pack(
            "<BBBBHHII",
            size if size < 256 else 0,
            size if size < 256 else 0,
            0,
            0,
            1,
            32,
            len(data),
            offset + len(blobs),
        )
        blobs += data
    with open(path, "wb") as f:
        f.write(struct.pack("<HHH", 0, 1, count) + entries + blobs)


# ---------------------------------------------------------------- RES 文件

RT_ICON = 3
RT_GROUP_ICON = 14
RT_VERSION = 16


def _pad_to(n):
    return b"\x00" * ((4 - n % 4) % 4)


def _vs_block(key, value, value_len, wtype, children=b""):
    """构造 VS_VERSIONINFO 结构的单个块（含自身 6 字节头）"""
    k = key.encode("utf-16-le") + b"\x00\x00"
    body = k + _pad_to(6 + len(k))
    if value:
        body += value + _pad_to(6 + len(body) + len(value))
    body += children
    return struct.pack("<HHH", 6 + len(body), value_len, wtype) + body


def version_blob(ver="1.6.0.0"):
    """生成 RT_VERSION 资源：让 exe 属性里能看到名称与版本号"""
    desc = "GitHub Release 下载整理工具"
    nums = [int(x) for x in ver.split(".")]
    while len(nums) < 4:
        nums.append(0)
    ms = (nums[0] << 16) | nums[1]
    ls = (nums[2] << 16) | nums[3]
    fixed = struct.pack(
        "<13I",
        0xFEEF04BD,  # dwSignature
        0x00010000,  # dwStrucVersion
        ms,
        ls,
        ms,
        ls,
        0x3F,  # dwFileFlagsMask
        0,  # dwFileFlags
        0x00040004,  # dwFileOS = VOS_NT_WINDOWS32
        1,  # dwFileType = VFT_APP
        0,
        0,
        0,
    )

    strings = [
        ("FileDescription", desc),
        ("FileVersion", ver),
        ("InternalName", "release-organizer"),
        ("OriginalFilename", "GitHub下载整理工具.exe"),
        ("ProductName", "GitHub Release 下载整理工具"),
        ("ProductVersion", ver),
    ]
    st = b""
    for key, val in strings:
        st += _vs_block(key, val.encode("utf-16-le") + b"\x00\x00", len(val) + 1, 1)

    # 语言 0x0804(简体中文) / 代码页 0x04B0(1200, Unicode)
    table = _vs_block("080404B0", b"", 0, 1, st)
    sfi = _vs_block("StringFileInfo", b"", 0, 1, table)
    var = _vs_block("Translation", struct.pack("<HH", 0x0804, 0x04B0), 4, 0)
    vfi = _vs_block("VarFileInfo", b"", 0, 1, var)
    return _vs_block("VS_VERSION_INFO", fixed, 52, 0, sfi + vfi)


def res_entry(rtype, rname, data, lang=0):
    """构造一条 .res 记录"""
    head = b""
    if isinstance(rtype, int):
        head += struct.pack("<HH", 0xFFFF, rtype)
    else:
        head += rtype.encode("utf-16-le") + b"\x00\x00"
    if isinstance(rname, int):
        head += struct.pack("<HH", 0xFFFF, rname)
    else:
        head += rname.encode("utf-16-le") + b"\x00\x00"
    if len(head) % 4:
        head += b"\x00" * (4 - len(head) % 4)
    head += struct.pack("<IHHII", 0, 0x1030, lang, 0, 0)
    return struct.pack("<II", len(data), len(head)) + head + data


def res_pad(n):
    return b"" if n % 4 == 0 else b"\x00" * (4 - n % 4)


def write_res(images, path):
    # .res 文件以一个 32 字节的空记录开头（MS 资源格式要求，缺了链接器会报 LNK1136）
    out = struct.pack("<II", 0, 0x20) + b"\xff\xff\x00\x00" * 2 + b"\x00" * 16
    group = b""
    group += struct.pack("<HHH", 0, 1, len(images))
    for idx, (size, data) in enumerate(images, start=1):
        out += res_entry(RT_ICON, idx, data)
        out += res_pad(len(data))
        group += struct.pack(
            "<BBBBHHIH",
            size if size < 256 else 0,
            size if size < 256 else 0,
            0,
            0,
            1,
            32,
            len(data),
            idx,
        )
    out += res_entry(RT_GROUP_ICON, 1, group)
    out += res_pad(len(group))
    ver = version_blob()
    out += res_entry(RT_VERSION, 1, ver)
    out += res_pad(len(ver))
    with open(path, "wb") as f:
        f.write(out)


def main():
    images = []
    big = None
    for size in SIZES:
        px = render(size)
        images.append((size, dib(px, size)))
        if size == 256:
            big = px

    write_ico(images, os.path.join(HERE, "icon.ico"))
    write_res(images, os.path.join(HERE, "icon.res"))

    with open(os.path.join(HERE, "icon.rgba"), "wb") as f:
        f.write(to_bytes(big, 256))

    # 预览图（PNG，仅用于检查效果）
    try:
        import zlib

        def chunk(tag, data):
            c = struct.pack(">I", len(data)) + tag + data
            return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

        raw = b""
        for y in range(256):
            raw += b"\x00"
            for x in range(256):
                r, g, b, a = big[y][x]
                raw += bytes(
                    (
                        int(r * 255 + 0.5),
                        int(g * 255 + 0.5),
                        int(b * 255 + 0.5),
                        int(a * 255 + 0.5),
                    )
                )

        ihdr = struct.pack(">IIBBBBB", 256, 256, 8, 6, 0, 0, 0)
        with open(os.path.join(HERE, "preview.png"), "wb") as f:
            f.write(
                b"\x89PNG\r\n\x1a\n"
                + chunk(b"IHDR", ihdr)
                + chunk(b"IDAT", zlib.compress(raw, 9))
                + chunk(b"IEND", b"")
            )
    except Exception as exc:  # noqa: BLE001
        print("preview skipped:", exc)

    print("icon.ico / icon.res / icon.rgba 生成完成（像素风 16x16 最近邻放大）")


if __name__ == "__main__":
    main()
