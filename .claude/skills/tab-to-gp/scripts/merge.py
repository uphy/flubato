#!/usr/bin/env python3
"""ページごとの alphaTex（voice1 / voice2 の区切りコメント付き）を1曲にまとめる。

usage: merge.py header.atex out.atex p01.atex p02.atex ...
header.atex はメタデータ（\\title など）から `.` と `\\ts` までを持つ。
各ページの `// === voice1 ===` 〜 `// === voice2 ===` を voice1 に、それ以降を voice2 に連結する。
"""
import re
import sys


def close_bar(block):
    """ページ末の小節線が省かれていると次ページの頭とつながるので補う"""
    lines = block.splitlines()
    for i in range(len(lines) - 1, -1, -1):
        code = lines[i].split("//", 1)[0].rstrip()
        if code:
            if not code.endswith("|"):
                lines[i] = code + " |" + lines[i][len(code):]
            break
    return "\n".join(lines)


header, out, pages = sys.argv[1], sys.argv[2], sys.argv[3:]
v1, v2 = [], []
for p in pages:
    text = open(p, encoding="utf-8").read()
    a = text.index("// === voice1 ===")
    b = text.index("// === voice2 ===")
    strip = lambda s: close_bar(re.sub(r"^\s*\\voice\s*$", "", s, flags=re.M).strip())
    v1.append(f"// ---- {p} ----\n" + strip(text[a + 17:b]))
    v2.append(f"// ---- {p} ----\n" + strip(text[b + 17:]))

with open(out, "w", encoding="utf-8") as f:
    f.write(open(header, encoding="utf-8").read().rstrip() + "\n")
    f.write("\\voice\n" + "\n".join(v1) + "\n")
    f.write("\\voice\n" + "\n".join(v2) + "\n")
print(out)
