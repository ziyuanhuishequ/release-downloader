"""生成 GitHub 小图标（rust/assets/gh.rgba，64x64 RGBA）。

官方 mark-github 是一条自交的复合轮廓，直接栅格化容易把内外填反；
这里按同样的造型手绘：圆头 + 两只尖耳 + 右侧尾巴 + 底部分腿，
在 24~32px 的按钮里足够认出来，也和应用的像素风一致。
"""
from PIL import Image, ImageDraw

SS = 4                 # 超采样
SIZE = 64              # 输出边长
N = SIZE * SS
INK = (26, 30, 48)

img = Image.new("L", (N, N), 0)
d = ImageDraw.Draw(img)


def sc(v):
    return v * SS


cx, cy, r = 32, 33, 21

# 头：圆形
d.ellipse([sc(cx - r), sc(cy - r), sc(cx + r), sc(cy + r)], fill=255)

# 两只尖耳（从头顶斜出去，和官方造型一致）
d.polygon([(sc(13), sc(20)), (sc(17), sc(6)), (sc(27), sc(14))], fill=255)
d.polygon([(sc(51), sc(20)), (sc(47), sc(6)), (sc(37), sc(14))], fill=255)

# 右侧尾巴：一小段向外翘的肢体
d.polygon([(sc(50), sc(40)), (sc(59), sc(36)), (sc(58), sc(45)), (sc(50), sc(46))], fill=255)
d.ellipse([sc(54), sc(33), sc(62), sc(41)], fill=255)

# 底部两条腿之间的缺口，避免看起来是实心圆
d.polygon([(sc(30), sc(48)), (sc(34), sc(48)), (sc(35), sc(58)), (sc(29), sc(58))], fill=0)

# 缩小到目标尺寸，得到抗锯齿的边
small = img.resize((SIZE, SIZE), Image.LANCZOS)

buf = bytearray(SIZE * SIZE * 4)
px = small.load()
for y in range(SIZE):
    for x in range(SIZE):
        a = px[x, y]
        o = (y * SIZE + x) * 4
        buf[o] = INK[0]
        buf[o + 1] = INK[1]
        buf[o + 2] = INK[2]
        buf[o + 3] = a

open("rust/assets/gh.rgba", "wb").write(bytes(buf))
print("wrote rust/assets/gh.rgba", len(buf), "bytes")
