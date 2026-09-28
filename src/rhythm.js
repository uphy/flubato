// タブ譜の数字の下に、拍の長さを音符風に描く（Guitar Pro のタブ譜のリズム表記と同じ考え方）。
// 練習モードの譜面と音ゲーモードのレーンの両方で使う。
// 符尾だけで符頭は描かない: 2分は短い符尾、4分は符尾、8分より短いものは旗か連桁。付点・連符の数字・休符も。
// 旗と休符は五線譜と同じ形。色が半透明なので、塗る部品は輪郭を集めて一度で塗る（fillShapes）。
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
    if (r.rest) { drawRest(g, x, Y(16), r.duration, r.dots); continue; }
    // 符尾は数字から伸ばす。2分は4分と見分けられるよう、連桁の位置まで届かせずに短く止める
    const end = r.duration === 2 ? y1 - 10 : y1;
    if (r.duration >= 2) {
      g.beginPath(); g.moveTo(x, stemFrom(r) ?? Y(y0)); g.lineTo(x, Y(end)); g.stroke();
    }
    const shapes = [];
    if (!beamed.has(r)) {
      // 旗: 符尾の先から右へふくらみ、根元のほうへ巻き戻る鉤（五線譜の旗の形）
      for (let k = 0; k < flags(r.duration); k++) {
        // 外側の線で先端から尾まで、内側の線で符尾へ戻る。根元が太く、尾は細く符尾側へ巻き戻る
        const o = y1 - k * 5, P = (dx, back) => [x + dx, Y(o - back)];
        shapes.push([...bezier(P(0.6, 0), P(1.5, 4), P(12, 5), P(6, 14)), ...bezier(P(6.8, 13.6), P(10, 7.5), P(2.5, 6.5), P(0.6, 5)).slice(1)]);
      }
    }
    const dotX = x + (beamed.has(r) || r.duration < 8 ? 6 : 13); // 旗があれば旗の右
    for (let k = 0; k < r.dots; k++) shapes.push(circle(dotX + 1 + k * 6, Y(end - 2), 2.6));
    fillShapes(g, shapes);
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

/**
 * 休符（y は真ん中）。数字の段の細い線に紛れないよう、五線譜の休符に近い塗りの形で描く。
 * 全休符は短い線から下にぶら下がる四角、2分休符は線の上に乗る四角（線があるので上下で見分けられる）。
 * 4分休符はジグザグの稲妻形、8分より短いものは斜めの棒に、旗の数だけ玉の付いた鉤。付点は右に点。
 * 色は半透明なので、部品を別々に塗ると重なりが濃くなる。輪郭を1つのパスに集めて一度で塗る
 */
function drawRest(g, x, y, d, dots = 0) {
  const shapes = [];
  let right = x + 6; // 付点を置く位置
  if (d <= 2) {
    const ly = d === 1 ? y - 3 : y + 3; // 線の高さ
    shapes.push(rect(x - 8, ly - 0.7, 16, 1.4), rect(x - 5, d === 1 ? ly : ly - 5, 10, 5));
    right = x + 9;
  } else if (d === 4) {
    // 上から: 右下への斜線 → 左下への太い帯 → 右下への斜線 → 左へ巻く鉤
    const P = (u, v) => [x + u, y + v];
    shapes.push(
      stroke([P(-2.5, -10), P(2.5, -4.5)], 1.6),
      stroke([P(2.5, -4.5), P(-2.5, 0.5)], 3.4),
      stroke([P(-2.5, 0.5), P(3, 5.5)], 1.6),
      stroke(bezier(P(3, 5.5), P(-1, 3), P(-6, 7), P(-0.5, 10.5)), 1.6),
    );
  } else {
    const n = Math.max(1, Math.round(Math.log2(d / 4))); // 8分=1, 16分=2 …
    const top = y - 4 - (n - 1) * 3, bottom = y + 8, xAt = yy => x + 3 - (yy - top) * 0.3; // 棒は右上から左下へ
    shapes.push(stroke([[xAt(top), top], [xAt(bottom), bottom]], 1.5));
    for (let k = 0; k < n; k++) {
      const fy = top + k * 5, fx = xAt(fy);
      shapes.push(stroke(bezier([fx, fy], [fx - 2, fy + 2.5], [fx - 4, fy + 2.5], [fx - 6.5, fy + 1]), 1.4), circle(fx - 6.5, fy + 0.5, 2.3));
    }
  }
  for (let k = 0; k < dots; k++) shapes.push(circle(right + 3.5 + k * 6, y - 2, 2.6));
  fillShapes(g, shapes);
}

/** 輪郭の点列をまとめて1つのパスにし、一度で塗る */
function fillShapes(g, shapes) {
  if (!shapes.length) return;
  g.beginPath();
  for (const pts of shapes) {
    // どの輪郭も同じ向き（時計回り）にそろえる。向きが逆だと nonzero の塗りで重なりが抜ける
    const area = pts.reduce((a, [px, py], i) => { const [qx, qy] = pts[(i + 1) % pts.length]; return a + px * qy - qx * py; }, 0);
    const ps = area < 0 ? [...pts].reverse() : pts;
    ps.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
    g.closePath();
  }
  g.fill();
}

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const circle = (cx, cy, r, n = 16) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos(i / n * 2 * Math.PI), cy + r * Math.sin(i / n * 2 * Math.PI)]);
const bezier = (a, b, c, d, n = 12) => Array.from({ length: n + 1 }, (_, i) => {
  const t = i / n, u = 1 - t;
  return [0, 1].map(j => u * u * u * a[j] + 3 * u * u * t * b[j] + 3 * u * t * t * c[j] + t * t * t * d[j]);
});
/** 折れ線を幅 w の帯にした輪郭（端は丸く） */
function stroke(pts, w) {
  const h = w / 2, left = [], right = [];
  pts.forEach(([px, py], i) => {
    const [ax, ay] = pts[Math.max(0, i - 1)], [bx, by] = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / len * h, ny = (bx - ax) / len * h;
    left.push([px + nx, py + ny]); right.push([px - nx, py - ny]);
  });
  const cap = ([cx, cy], [nx, ny], n = 6) => Array.from({ length: n - 1 }, (_, i) => {
    const a = -Math.PI * (i + 1) / n, c = Math.cos(a), s = Math.sin(a); // 法線を外側へ半周回す
    return [cx + nx * c - ny * s, cy + nx * s + ny * c];
  });
  const n0 = [left[0][0] - pts[0][0], left[0][1] - pts[0][1]];
  const last = pts.length - 1, n1 = [right[last][0] - pts[last][0], right[last][1] - pts[last][1]];
  return [...left, ...cap(pts[last], n1.map(v => -v)), ...right.reverse(), ...cap(pts[0], n0.map(v => -v))];
}
