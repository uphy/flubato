#!/usr/bin/env python3
"""手書き TAB のページ画像を段ごとに切り出す。

usage: crop.py page.jpg outprefix
6本の横線がまとまっている所を1段とみなし、上下に余白を付けて outprefix-sN.png を書く。
さらに各段を左右半分（少し重ねる）に分けた outprefix-sN-L.png / -R.png も書く（数字の読み取り用）。
"""
import sys
from PIL import Image

src, prefix = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("L")
w, h = im.size
# 線が薄いスキャンもあるので、見つかるまで閾値を緩める
for thr, ratio in [(130, 0.3), (160, 0.25), (190, 0.2), (210, 0.15)]:
    rows = [sum(1 for x in range(0, w, 2) if im.getpixel((x, y)) < thr) for y in range(h)]
    lines = [y for y, c in enumerate(rows) if c > w * ratio / 2]
    if len(lines) >= 30:
        break
groups = []
for y in lines:
    if groups and y - groups[-1][-1] <= 3:
        groups[-1].append(y)
    else:
        groups.append([y])
centers = [sum(g) // len(g) for g in groups]
systems, cur = [], [centers[0]]
for c in centers[1:]:
    if c - cur[-1] < 80:
        cur.append(c)
    else:
        systems.append(cur)
        cur = [c]
systems.append(cur)
systems = [s for s in systems if len(s) >= 5]
for i, s in enumerate(systems, 1):
    top, bot = max(0, s[0] - 200), min(h, s[-1] + 200)
    sysim = im.crop((0, top, w, bot))
    sysim.save(f"{prefix}-s{i}.png")
    sysim.crop((0, 0, w * 55 // 100, sysim.height)).save(f"{prefix}-s{i}-L.png")
    sysim.crop((w * 45 // 100, 0, w, sysim.height)).save(f"{prefix}-s{i}-R.png")
    print(f"{prefix}-s{i}.png lines={len(s)} y={s[0]}..{s[-1]}")
