// タブ譜の数字の下に、拍の長さを音符風に描く（Guitar Pro のタブ譜のリズム表記と同じ考え方）。
// 練習モードの譜面と音ゲーモードのレーンの両方で使う。
// 符尾だけで符頭は描かない: 2分は短い符尾、4分は符尾、8分より短いものは旗か連桁。付点・連符の数字・休符も。
// 連桁は拍ごと（8分の6拍子などは付点4分ごと）にまとめる。
// 符尾は数字のところまで伸ばす（どの数字の長さかを棒でたどれるように）。声部が2つある小節は、
// 上の声部を段の上に上向きで、下の声部を段の下に下向きで描く（chart.rhythm の up）。

export const RHYTHM_H = 34; // リズムの段の高さ

/**
 * items: chart.rhythm の一部（時刻順）。xOf(item) で横位置。
 * L はいちばん下の弦の y（下向きの符尾の段がこの下に付く）、T はいちばん上の弦の y（上向きの符尾の段がこの上に付く）。
 * stemFrom(item) は符尾を始める y（数字のすぐ下／上）。undefined なら段の端から
 */
export function drawRhythm(g, chart, items, xOf, { L, T = L, stemFrom = () => undefined }, color = 'rgba(255,255,255,0.5)') {
  if (!items.length) return;
  g.save();
  g.strokeStyle = g.fillStyle = color;
  g.lineWidth = 1.2;
  drawSide(g, chart, items.filter(r => !r.up), xOf, L, 1, stemFrom);
  drawSide(g, chart, items.filter(r => r.up), xOf, T, -1, stemFrom);
  g.restore();
}

/** 片方の向きの符尾・連桁。s = 1 で下向き（base の下へ）、-1 で上向き（base の上へ） */
function drawSide(g, chart, items, xOf, base, s, stemFrom) {
  if (!items.length) return;
  const Y = off => base + s * off; // 段の端からの距離 → y
  const y0 = 8, y1 = 26; // 符尾の段の端側・外側（連桁の位置）
  const beatKey = r => {
    const bar = chart.bars[r.bar];
    const unit = bar.den === 8 && bar.num % 3 === 0 ? 1440 : 3840 / bar.den; // 連桁をまとめる単位（tick）
    return `${r.bar}:${Math.floor(r.tick / unit)}`;
  };
  const flags = d => Math.max(0, Math.log2(d / 4)); // 8分=1, 16分=2 …

  // 連桁のまとまり
  const beams = [];
  let cur = null;
  for (const r of items) {
    const key = beatKey(r);
    if (!r.rest && r.duration >= 8) {
      if (cur && cur.key === key) cur.items.push(r);
      else { cur = { key, items: [r] }; beams.push(cur); }
    } else cur = null;
  }
  const beamed = new Set(beams.filter(bm => bm.items.length > 1).flatMap(bm => bm.items));

  for (const r of items) {
    const x = xOf(r);
    if (r.rest) { drawRest(g, x, Y(16), r.duration); continue; }
    // 符尾は数字から伸ばす。2分は4分と見分けられるよう、連桁の位置まで届かせずに短く止める
    const end = r.duration === 2 ? y1 - 10 : y1;
    if (r.duration >= 2) {
      g.beginPath(); g.moveTo(x, stemFrom(r) ?? Y(y0)); g.lineTo(x, Y(end)); g.stroke();
    }
    if (!beamed.has(r)) {
      for (let k = 0; k < flags(r.duration); k++) {
        g.beginPath(); g.moveTo(x, Y(y1 - k * 5)); g.lineTo(x + 6, Y(y1 - 6 - k * 5)); g.stroke();
      }
    }
    for (let k = 0; k < r.dots; k++) { g.beginPath(); g.arc(x + 5 + k * 4, Y(end - 2), 1.4, 0, Math.PI * 2); g.fill(); }
  }
  // 連桁（16分なら2本目も。隣と組めない16分は短い桁）
  for (const bm of beams) {
    if (bm.items.length < 2) continue;
    const xs = bm.items.map(xOf);
    g.fillRect(xs[0], Y(y1) - 1.5, xs[xs.length - 1] - xs[0], 3);
    const maxLevel = Math.max(...bm.items.map(r => flags(r.duration)));
    for (let lv = 2; lv <= maxLevel; lv++) {
      const y = Y(y1 - (lv - 1) * 5) - 1.5;
      bm.items.forEach((r, k) => {
        if (flags(r.duration) < lv) return;
        const nxt = bm.items[k + 1], prv = bm.items[k - 1];
        if (nxt && flags(nxt.duration) >= lv) g.fillRect(xs[k], y, xs[k + 1] - xs[k], 3);
        else if (!(prv && flags(prv.duration) >= lv)) g.fillRect(k === 0 ? xs[k] : xs[k] - 6, y, 6, 3);
      });
    }
  }
  // 連符の数字（同じ連符が続くところを N 個ずつ）
  g.font = '600 10px -apple-system, system-ui, sans-serif';
  g.textAlign = 'center';
  for (let i = 0; i < items.length;) {
    const n = items[i].tuplet;
    if (!n) { i++; continue; }
    let j = i;
    while (j < items.length && j - i < n && items[j].tuplet === n && items[j].bar === items[i].bar) j++;
    g.fillText(String(n), (xOf(items[i]) + xOf(items[j - 1])) / 2, Y(y1 + 9));
    i = j;
  }
}

/** 休符（簡略な形。y は真ん中）: 全・2分は四角、4分はジグザグ、8分より短いものは斜線と旗の数の点 */
function drawRest(g, x, y, d) {
  if (d <= 2) { g.fillRect(x - 4, d === 1 ? y - 3 : y, 8, 3); return; }
  if (d === 4) {
    g.beginPath(); g.moveTo(x - 1, y - 7); g.lineTo(x + 3, y - 3); g.lineTo(x - 2, y + 1); g.lineTo(x + 3, y + 6); g.stroke();
    return;
  }
  g.beginPath(); g.moveTo(x + 3, y - 5); g.lineTo(x - 1, y + 6); g.stroke();
  for (let k = 0; k < Math.log2(d / 4); k++) { g.beginPath(); g.arc(x + 1 - k * 2, y - 4 + k * 4, 1.6, 0, Math.PI * 2); g.fill(); }
}
