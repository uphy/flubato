#!/usr/bin/env python3
"""印刷譜の PDF（文字情報入り）から TAB の数字を座標ごと取り出し、小節ごとに並べる。

usage: pdftab.py score.pdf outdir [--tuning "E4 B3 G3 D3 A2 D2"] [--dpi 300]

- TAB 譜の数字は PDF の文字として入っていることが多い（Power Tab・Guitar Pro などが書き出した譜面）。
  その座標から弦（縦位置）と拍の並び（横位置）を機械的に決める。画像を読むより弦の読み違いが無い
- 五線と TAB の横線、小節線はページ画像から探す（線は文字ではなく図形のため）
- 書き出すもの
  - outdir/listing.txt  小節ごとの音の列。各列は alphaTex の形（`(2.3 0.6)`）と小節内の横位置（0〜1）
  - outdir/mNNN.png     小節ごとの画像（五線 + TAB）。リズムはこれを見て決める
  - outdir/pN-sM.png    段ごとの画像
文字情報が無い PDF（スキャン）では何も取れない。そのときは pdftoppm で画像にして手書きと同じ手順で読む。
"""
import argparse
import html
import os
import re
import subprocess
import sys
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("pdf")
ap.add_argument("outdir")
ap.add_argument("--dpi", type=int, default=300)
ap.add_argument("--tuning", default="E4 B3 G3 D3 A2 E2", help="1弦から順に（ドロップ D なら E4 B3 G3 D3 A2 D2）")
ap.add_argument("--pages", help="対象のページ（例 8-13）。曲集から1曲だけ取り出すときに使う")
ap.add_argument("--no-text", action="store_true",
                help="PDF の文字を使わない。スキャンに OCR をかけた PDF は数字が化けているので、小節ごとの画像だけを作る")
args = ap.parse_args()
pdf, outdir, dpi = args.pdf, args.outdir, args.dpi
k = dpi / 72  # pt → px
NAMES = "C C# D D# E F F# G G# A A# B".split()
OPEN = [NAMES.index(t[:-1]) + 12 * int(t[-1]) for t in args.tuning.split()]


def written(s, fret):
    """五線での音名（ギターの五線は実音の1オクターブ上に書く。カポは数えない）"""
    if not fret.isdigit() or s > len(OPEN):
        return "x"
    n = OPEN[s - 1] + int(fret) + 12
    return f"{NAMES[n % 12]}{n // 12}"

os.makedirs(outdir, exist_ok=True)

# ---- 文字と座標 ----
bbox = subprocess.run(["pdftotext", "-bbox", pdf, "-"], capture_output=True, text=True, check=True).stdout
pages = []
for page in re.findall(r"<page .*?</page>", bbox, re.S):
    words = []
    for m in re.finditer(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>', page):
        x0, y0, x1, y1 = map(float, m.groups()[:4])
        words.append(dict(x0=x0, y0=y0, x1=x1, y1=y1, t=html.unescape(m.group(5))))
    pages.append(words)


def page_image(n):
    path = os.path.join(outdir, f"pg-{n}.png")
    if not os.path.exists(path):
        subprocess.run(["pdftoppm", "-r", str(dpi), "-png", "-f", str(n), "-l", str(n), "-singlefile",
                        pdf, path[:-4]], check=True)
    return Image.open(path).convert("L")


def staffs(im):
    """横線を探し、等間隔に並ぶまとまりを返す（6本 = TAB、5本 = 五線）"""
    w, h = im.size
    px = im.load()
    rows = [y for y in range(h) if sum(1 for x in range(0, w, 4) if px[x, y] < 128) > w / 4 * 0.5]
    lines = []
    for y in rows:
        if lines and y - lines[-1][-1] <= 2:
            lines[-1].append(y)
        else:
            lines.append([y])
    ys = [sum(g) / len(g) for g in lines]
    groups, cur = [], [ys[0]] if ys else []
    for y in ys[1:]:
        if len(cur) >= 2 and abs((y - cur[-1]) - (cur[1] - cur[0])) > 3 or y - cur[-1] > 12 * k:
            groups.append(cur)
            cur = [y]
        else:
            cur.append(y)
    if cur:
        groups.append(cur)
    return groups


def barlines(im, top, bot):
    """top〜bot（px）を縦に貫く線の x（px）。

    全弦に数字が並ぶ和音（とアルペジオの波線）も TAB を縦に埋める。小節線は1本目と6本目の線でちょうど止まるが、
    数字は端の線の外へ半分はみ出す。はみ出しが短い（遠くまでは続かない）ものを数字の列として除く。
    五線から続く段の左端の線は上へ長く伸びるので残る
    """
    px = im.load()
    h = im.size[1]
    sp = (bot - top) / 5

    def dark(x, y):
        return 0 <= y < h and px[x, y] < 128

    xs = [x for x in range(im.size[0])
          if sum(1 for y in range(int(top), int(bot) + 1) if px[x, y] < 128) >= (bot - top) * 0.95]
    out = []
    for x in xs:
        if out and x - out[-1][-1] <= 3:
            out[-1].append(x)
        else:
            out.append([x])

    def digits(g):
        near = lambda y: any(dark(x, int(y)) for x in g)
        return (near(top - 0.35 * sp) and not near(top - 1.5 * sp)) or \
               (near(bot + 0.35 * sp) and not near(bot + 1.5 * sp))

    return [(g[0], g[-1]) for g in out if not digits(g)]


# 7 / (7) 括弧 / [12] 角括弧（自然ハーモニクス） / x（デッドノート）。"[12]([12])" のように1語につながることもある
NOTE = re.compile(r"\(?\[?(\d{1,2}|x|X)\]?\)?")
listing = []
mnum = 0
first, last = 1, len(pages)
if args.pages:
    first, last = (int(v) for v in (args.pages.split("-") + [args.pages])[:2])
for pn in range(first, last + 1):
    words = [] if args.no_text else pages[pn - 1]
    im = page_image(pn)
    groups = staffs(im)
    tabs = [g for g in groups if len(g) == 6]
    fives = [g for g in groups if len(g) == 5]
    for sn, tab in enumerate(tabs, 1):
        sp = (tab[-1] - tab[0]) / 5 / k  # 線の間隔（pt）
        l1, l6 = tab[0] / k, tab[-1] / k
        notation = [g for g in fives if g[-1] < tab[0] and tab[0] - g[-1] < 120 * k]
        top_px = (notation[-1][0] if notation else tab[0]) - 45 * k
        bars = barlines(im, tab[0], tab[-1])
        # 段の頭の小節番号（五線の左端の数字）
        lefts = [w for w in words if w["x1"] < bars[0][0] / k + 2 and w["t"].isdigit()
                 and top_px / k < w["y0"] < l1]
        # 番号を振り直す譜面もある（Power Tab は最終ページで 1 に戻ることがある）ので、増える向きのときだけ使う
        if lefts and int(lefts[0]["t"]) > mnum:
            mnum = int(lefts[0]["t"]) - 1
        crop_bot = tab[-1] + 25 * k
        im.crop((0, max(0, int(top_px)), im.size[0], int(crop_bot))).save(os.path.join(outdir, f"p{pn}-s{sn}.png"))
        # TAB の範囲にある文字（音と注記）
        near = [w for w in words if l1 - 2.5 * sp < (w["y0"] + w["y1"]) / 2 < l6 + 2.5 * sp
                and w["x0"] > bars[0][1] / k]
        for (a, _), (_, b) in zip(bars, bars[1:]):
            xa, xb = a / k, b / k
            if xb - xa < 10:
                continue  # 反復記号などの二重線
            mnum += 1
            inside = [w for w in near if xa < (w["x0"] + w["x1"]) / 2 < xb]
            notes, marks = [], []
            for w in inside:
                cy = (w["y0"] + w["y1"]) / 2
                base = w["y0"] + 0.295 * (w["y1"] - w["y0"])  # この高さが TAB の線に重なる
                toks = list(NOTE.finditer(w["t"]))
                if toks and "".join(t.group(0) for t in toks) == w["t"] and l1 - sp / 2 < base < l6 + sp / 2:
                    s = round((base - l1) / sp) + 1
                    small = (w["y1"] - w["y0"]) < 9
                    cw = (w["x1"] - w["x0"]) / len(w["t"])
                    for t in toks:
                        notes.append(dict(x=w["x0"] + cw * (t.start() + t.end()) / 2, s=s, f=t.group(1).lower(),
                                          paren="(" in t.group(0), harm="[" in t.group(0), small=small))
                else:
                    pos = "上" if cy < l1 else "下" if cy > l6 else "中"
                    marks.append(f'"{w["t"]}"@{((w["x0"] + w["x1"]) / 2 - xa) / (xb - xa):.2f}{pos}')
            notes.sort(key=lambda n: n["x"])
            cols = []
            for n in notes:
                if cols and n["x"] - cols[-1][-1]["x"] < 3.5:
                    cols[-1].append(n)
                else:
                    cols.append([n])
            lines = [f"m{mnum}  [p{pn} s{sn}]  m{mnum:03d}.png"]
            for c in cols:
                c.sort(key=lambda n: n["s"])
                tex = " ".join(f'{n["f"]}.{n["s"]}' for n in c)
                tex = f"({tex})" if len(c) > 1 else tex
                flags = []
                if any(n["paren"] for n in c):
                    flags.append("括弧: " + " ".join(f'{n["s"]}弦' for n in c if n["paren"]))
                if any(n["harm"] for n in c):
                    flags.append("角括弧（自然ハーモニクス）: " + " ".join(f'{n["s"]}弦' for n in c if n["harm"]))
                if any(n["small"] for n in c):
                    flags.append("小さい数字（装飾音か）: " + " ".join(f'{n["s"]}弦' for n in c if n["small"]))
                pos = ((sum(n["x"] for n in c) / len(c)) - xa) / (xb - xa)
                pitch = " ".join(written(n["s"], n["f"]) for n in c)
                lines.append(f"  {pos:.2f}  {tex:<22} [{pitch}]" + (f"   // {'、'.join(flags)}" if flags else ""))
            marks = [m for m in marks if not re.match(r'"[TAB]"@0\.0\d中$', m)]  # 段の頭の T A B
            if marks:
                lines.append("  注記: " + " ".join(marks))
            listing.append("\n".join(lines))
            im.crop((max(0, a - 8 * k), max(0, int(top_px)), min(im.size[0], b + 8 * k), int(crop_bot))) \
              .save(os.path.join(outdir, f"m{mnum:03d}.png"))
        print(f"p{pn} s{sn}: 小節線 {len(bars)} 本, 線の間隔 {sp:.2f}pt, ここまで m{mnum}")

with open(os.path.join(outdir, "listing.txt"), "w", encoding="utf-8") as f:
    f.write("\n\n".join(listing) + "\n")
print(f"{mnum} 小節 → {outdir}/listing.txt")
