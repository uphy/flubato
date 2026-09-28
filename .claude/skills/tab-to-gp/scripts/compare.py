#!/usr/bin/env python3
"""原本の段画像と、描画した PNG の一部を上下に並べる（読み違いを目で探すため）。

usage: compare.py original.png rendered.png out.png [top bottom]
top / bottom は rendered.png を切り出す縦の範囲（px）。省略すると全体。
"""
import sys
from PIL import Image, ImageDraw

orig, rend, out = sys.argv[1:4]
W = 2000
o = Image.open(orig).convert("RGB")
r = Image.open(rend).convert("RGB")
if len(sys.argv) >= 6:
    r = r.crop((0, int(sys.argv[4]), r.width, int(sys.argv[5])))
o = o.resize((W, int(o.height * W / o.width)))
r = r.resize((W, int(r.height * W / r.width)))
img = Image.new("RGB", (W, o.height + r.height + 20), "white")
img.paste(o, (0, 0))
ImageDraw.Draw(img).line((0, o.height + 8, W, o.height + 8), fill="red", width=4)
img.paste(r, (0, o.height + 20))
img.save(out)
print(out)
