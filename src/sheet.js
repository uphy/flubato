// 練習モードの画面。タブ譜を小節ごとに段組みして、いま弾いているところを光らせる（譜めくり型）。
// 1音ずつ線を通過させる見せ方と違い、小節単位で合っていれば困らない。
// 認識が少し遅れたり迷ったりしても、弾く人は先を読んでいるので止まらずにすむ。

import { drawRhythm, RHYTHM_H } from './rhythm.js';

const MIN_GROUP_PX = 32;
const CLEF_W = 30; // 段の頭の TAB の記号のぶん
const FONT = '-apple-system, system-ui, "Helvetica Neue", sans-serif';
// 色（index.html の CSS と合わせる）
const C = {
  bg: '#0e1016', ink: '#eceef3', played: 'rgba(236,238,243,0.28)', faint: 'rgba(236,238,243,0.38)', clef: 'rgba(236,238,243,0.3)',
  string: 'rgba(255,255,255,0.17)', barline: 'rgba(255,255,255,0.34)', rhythm: 'rgba(236,238,243,0.42)',
  accent: '#ffd24a', accentInk: '#1c1600', accentSoft: 'rgba(255,210,74,0.075)', hover: 'rgba(255,255,255,0.035)',
  bad: '#ff5f74', badSoft: 'rgba(255,95,116,0.13)',
};
// 振り返りで和音の下に出す印
export const MARK_TAGS = { hesitate: '止', late: '間', rush: '急', back: '戻', skip: '飛' };

export class SheetView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scroll = 0; // 表示中の先頭の段（なめらかに動かす）
    this.hits = []; // クリック判定用 { x0, x1, y0, y1, bar }
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._rowsFor = null;
  }

  /** 小節を段に割り付ける（幅は中の和音の数で決める） */
  _layout(chart) {
    if (this._rowsFor === chart && this._w === this.w) return this.rows;
    // 横に広い画面でも1段が長くなりすぎないよう、幅に上限を付けて真ん中に置く。左端は TAB の記号のぶん空ける
    const span = Math.min(this.w - 48, 1560);
    const left = (this.w - span) / 2 + CLEF_W, right = (this.w + span) / 2;
    this.rowLeft = left - CLEF_W;
    // 小節の中の横位置: 楽譜の組版と同じく、休符も含めて拍ごとに場所を取り、長い音ほど少し広く（時間の平方根）。
    // 時間に比例させると、休符のあとに短い音が続く小節で数字が右端に詰まって重なる
    this.barPos = new Map();
    const perBar = new Map();
    chart.bars.forEach((bar, i) => {
      const ts = [...new Set([...chart.rhythm.filter(r => r.bar === i).map(r => r.t), ...chart.groups.filter(g => g.bar === i).map(g => g.t)])].sort((a, b) => a - b);
      if (!ts.length) { perBar.set(i, 1); return; }
      const ws = ts.map((t, k) => Math.max(1, Math.sqrt(((ts[k + 1] ?? bar.end) - t) / 0.12)));
      const total = ws.reduce((a, b) => a + b, 0);
      let acc = 0;
      this.barPos.set(i, { ts, fr: ws.map(w => { const f = acc / total; acc += w; return f; }) });
      perBar.set(i, total * 0.8);
    });
    const rows = [];
    let row = [], x = left;
    chart.bars.forEach((bar, i) => {
      const w = Math.max(120, (perBar.get(i) || 1) * MIN_GROUP_PX + 28);
      if (row.length && x + w > right) {
        rows.push(row); row = []; x = left;
      }
      row.push({ i, x, w });
      x += w;
    });
    if (row.length) rows.push(row);
    // 段の中で右端までのばす（最後の段は、短ければ詰めたまま）
    for (const r of rows) {
      const used = r.reduce((a, b) => a + b.w, 0);
      const k = r === rows[rows.length - 1] && used < (right - left) * 0.6 ? 1 : (right - left) / used;
      let xx = left;
      for (const b of r) { b.w *= k; b.x = xx; xx += b.w; }
    }
    this.rowOfBar = new Map();
    this.boxOf = new Map();
    rows.forEach(r => r.forEach(b => this.boxOf.set(b.i, b)));
    rows.forEach((r, ri) => r.forEach(b => this.rowOfBar.set(b.i, ri)));
    // レガート（ハンマリング・プリング・スライド）の弧を、同じ弦の1つ前の音から引く
    this.prevOnString = new Map();
    const lastOn = new Map();
    for (const n of chart.notes) {
      if (n.kind === 'legato' && lastOn.has(n.string)) this.prevOnString.set(n.id, lastOn.get(n.string));
      lastOn.set(n.string, n.id);
    }
    this.rows = rows;
    this._rowsFor = chart; this._w = this.w;
    return rows;
  }

  /**
   * state: { pos（最後に弾いた group）, played: Uint8Array, conf, listening, stumbleBars: Set,
   *   review: { data（review.js の結果）, cursor（再生位置の group）, selected } }（振り返りのときだけ）
   */
  draw(chart, state) {
    const g = this.ctx, W = this.w, H = this.h;
    g.clearRect(0, 0, W, H);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    const rows = this._layout(chart);
    const rv = state.review;
    const areaH = H - (rv ? 64 : 0); // 振り返りのときは下に操作の帯が重なる
    const n1 = chart.stringCount - 1;
    const stringGap = Math.min(24, Math.max(14, areaH / 24));
    const staffH = stringGap * n1;
    const rowH = staffH + RHYTHM_H + stringGap * 2.6 + 24; // 下にリズム（符尾・連桁）の段と、段のあいだ
    const padTop = stringGap * 1.6 + 8;
    const fs = Math.round(stringGap * 0.8);
    const font = `600 ${fs}px ${FONT}`;

    const next = rv ? rv.cursor ?? rv.selected ?? -1 : Math.min(chart.groups.length - 1, state.pos + 1);
    const curBar = chart.groups[Math.max(0, next)]?.bar ?? 0;
    const curRow = this.rowOfBar.get(curBar) ?? 0;
    // いまの段が上から2段目に来るように（最初は1段目）
    const target = Math.max(0, Math.min(curRow - 1, rows.length - Math.max(1, Math.floor((areaH - padTop) / rowH))));
    this.scroll += (target - this.scroll) * 0.15;
    if (Math.abs(target - this.scroll) < 0.01) this.scroll = target;
    const topOf = ri => padTop + (ri - this.scroll) * rowH;
    const visible = ri => { const t = topOf(ri); return t < areaH + stringGap && t + rowH > 0; };

    this.hits = [];
    this.groupHits = [];
    g.save();
    g.beginPath(); g.rect(0, 0, W, areaH); g.clip();
    g.textBaseline = 'middle';

    // 先に音符の置き場所を決める（弦の線を数字のところで切るため）
    g.font = font;
    const placed = [];
    const gaps = new Map(); // `${段}:${弦}` → [[x0, x1]]
    chart.groups.forEach((grp, gi) => {
      const ri = this.rowOfBar.get(grp.bar);
      if (!visible(ri)) return;
      const top = topOf(ri), x = this.xAt(chart, grp.bar, grp.t);
      const notes = grp.noteIds.map(id => {
        const n = chart.notes[id];
        const label = n.kind === 'dead' ? '×' : n.kind === 'harmonic' ? `<${n.fret}>` : String(n.fret);
        const tw = g.measureText(label).width + fs * 0.35;
        const key = `${ri}:${n.string}`;
        if (!gaps.has(key)) gaps.set(key, []);
        gaps.get(key).push([x - tw / 2, x + tw / 2]);
        return { n, id, label, tw, y: top + (n.string - 1) * stringGap };
      });
      placed.push({ grp, gi, ri, top, x, notes });
    });

    // 段: 小節の地・弦・小節線・TAB の記号・小節番号・リズム
    rows.forEach((row, ri) => {
      if (!visible(ri)) return;
      const top = topOf(ri), bot = top + staffH;
      const x0 = this.rowLeft, last = row[row.length - 1], x1 = last.x + last.w;
      for (const b of row) {
        const isCur = b.i === curBar && (state.listening || rv);
        const stumble = state.stumbleBars?.has(b.i);
        if (isCur || stumble) {
          g.fillStyle = stumble ? C.badSoft : state.listening ? C.accentSoft : C.hover;
          roundRect(g, b.x + 1, top - stringGap * 1.2, b.w - 2, staffH + stringGap * 1.2 + RHYTHM_H + 8, 8);
          g.fill();
        }
        this.hits.push({ x0: b.x, x1: b.x + b.w, y0: top - stringGap * 1.4, y1: bot + RHYTHM_H + 8, bar: b.i });
        g.fillStyle = stumble ? C.bad : isCur ? C.accent : C.faint;
        g.font = `700 11px ${FONT}`;
        g.textAlign = 'left';
        g.fillText(String(chart.bars[b.i].number), b.x + 5, top - stringGap * 0.75);
      }
      // 弦（数字のところは切る）
      g.strokeStyle = C.string; g.lineWidth = 1;
      for (let s = 1; s <= chart.stringCount; s++) {
        const y = Math.round(top + (s - 1) * stringGap) + 0.5;
        const gs = (gaps.get(`${ri}:${s}`) ?? []).sort((a, b) => a[0] - b[0]);
        g.beginPath();
        let cx = x0;
        for (const [a, b] of gs) { if (a > cx) { g.moveTo(cx, y); g.lineTo(a, y); } cx = Math.max(cx, b); }
        if (cx < x1) { g.moveTo(cx, y); g.lineTo(x1, y); }
        g.stroke();
      }
      // 小節線（段の頭と、曲の終わりは太く）
      const barLine = (x, w = 1, color = C.barline) => {
        g.fillStyle = color; g.fillRect(Math.round(x - w / 2), Math.round(top), w, Math.round(staffH) + 1);
      };
      barLine(x0 + 0.5);
      for (const b of row.slice(1)) barLine(b.x);
      if (last.i === chart.bars.length - 1) { barLine(x1 - 6); barLine(x1 - 1.5, 3, C.ink); } else barLine(x1);
      // TAB
      g.font = `800 ${Math.round(Math.min(19, staffH / 4.6))}px ${FONT}`;
      g.textAlign = 'center';
      const ch = Math.round(Math.min(19, staffH / 4.6));
      ['T', 'A', 'B'].forEach((c, k) => {
        const y = top + staffH / 2 + (k - 1) * ch * 1.12;
        g.fillStyle = C.bg; g.fillRect(x0 + CLEF_W / 2 - ch * 0.5, y - ch * 0.5, ch, ch);
        g.fillStyle = C.clef; g.fillText(c, x0 + CLEF_W / 2, y + 0.5);
      });
      for (const b of row) drawRhythm(g, chart, chart.rhythm.filter(r => r.bar === b.i), r => this.xAt(chart, b.i, r.t), bot + fs * 0.3, C.rhythm);
    });

    // 音符
    const pill = (x, top, pad = 0) => roundRect(g, x - fs * 0.78 - pad, top - fs * 0.72 - pad, fs * 1.56 + pad * 2, staffH + fs * 1.44 + pad * 2, fs * 0.7);
    for (const { grp, gi, ri, top, x, notes } of placed) {
      const played = state.played?.[gi];
      const isNext = gi === next && (state.listening || !!rv);
      const R = rv?.data.groups[gi];
      this.groupHits.push({ x, y0: top - 8, y1: top + staffH + 14 + RHYTHM_H, g: gi });
      if (isNext) {
        g.save();
        g.shadowColor = 'rgba(255,210,74,0.45)'; g.shadowBlur = 16;
        g.fillStyle = C.accent; pill(x, top); g.fill();
        g.restore();
      } else if (rv && gi === rv.selected) {
        g.strokeStyle = C.ink; g.lineWidth = 1.5; pill(x, top); g.stroke();
      } else if (gi === state.pos && state.listening) {
        g.strokeStyle = state.conf < 0.35 ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.7)';
        g.setLineDash(state.conf < 0.35 ? [3, 3] : []);
        g.lineWidth = 1.5; pill(x, top); g.stroke();
        g.setLineDash([]);
      } else if (!state.listening && !rv && gi === next) {
        // 弾く前: どこから始まるか
        g.strokeStyle = 'rgba(255,210,74,0.55)'; g.setLineDash([4, 4]); g.lineWidth = 1.5;
        pill(x, top); g.stroke(); g.setLineDash([]);
      }
      const skipped = R?.marks.some(m => m.kind === 'skip');
      g.font = font; g.textAlign = 'center';
      for (const { n, id, label, tw, y } of notes) {
        const heard = R?.notes.get(id); // 'missing' | 'weak'
        const color = isNext ? C.accentInk
          : skipped || heard === 'missing' || played === 2 ? C.bad
          : played === 1 ? C.played
          : C.ink;
        g.fillStyle = color;
        g.fillText(label, x, y + 1);
        const p = this.prevOnString.get(id);
        if (p !== undefined) {
          // レガートの弧（前の音が同じ段にあれば、そこから）
          const pn = chart.notes[p], pr = this.rowOfBar.get(pn.bar);
          const px = pr === ri ? this.xAt(chart, pn.bar, pn.t) : x - fs * 2;
          g.strokeStyle = isNext ? C.accent : color; g.lineWidth = 1.3; g.globalAlpha = 0.8;
          g.beginPath();
          g.moveTo(px + fs * 0.3, y - fs * 0.62);
          g.quadraticCurveTo((px + x) / 2, y - fs * 0.62 - Math.min(10, (x - px) * 0.15 + 3), x - fs * 0.3, y - fs * 0.62);
          g.stroke(); g.globalAlpha = 1;
        }
        if (heard) {
          // 聞き取れなかった音は赤い斜線、小さかった音は点線の下線
          g.strokeStyle = C.bad; g.lineWidth = 1.6;
          g.setLineDash(heard === 'weak' ? [2, 2] : []);
          g.beginPath();
          if (heard === 'missing') { g.moveTo(x - tw / 2, y + fs / 2 - 1); g.lineTo(x + tw / 2, y - fs / 2 + 1); }
          else { g.moveTo(x - tw / 2, y + fs / 2 + 1); g.lineTo(x + tw / 2, y + fs / 2 + 1); }
          g.stroke(); g.setLineDash([]);
        }
      }
      // 和音の下に、どう悪かったかを1文字で
      const tags = (R?.marks ?? []).map(m => MARK_TAGS[m.kind]).filter(Boolean);
      if (tags.length) {
        const text = tags.join('');
        g.font = `700 11px ${FONT}`;
        const tw = g.measureText(text).width + 8, ty = top + staffH + RHYTHM_H + 12;
        g.fillStyle = C.badSoft; roundRect(g, x - tw / 2, ty - 8, tw, 16, 4); g.fill();
        g.fillStyle = C.bad; g.fillText(text, x, ty + 0.5);
      }
    }
    g.restore();
    g.textAlign = 'left';
  }

  /** 小節 i の中の時刻 t の横位置 */
  xAt(chart, i, t) {
    const b = this.boxOf.get(i), bar = chart.bars[i], p = this.barPos.get(i);
    let f = (t - bar.t) / Math.max(0.01, bar.end - bar.t);
    if (p) {
      let k = p.ts.findIndex(x => x >= t - 1e-4);
      if (k < 0) k = p.ts.length - 1;
      f = p.fr[k];
    }
    return b.x + 18 + f * (b.w - 30);
  }

  /** 画面上の点がどの和音か（なければ null） */
  groupAt(x, y) {
    let best = null, bd = 18;
    for (const h of this.groupHits ?? []) {
      if (y < h.y0 || y > h.y1) continue;
      const d = Math.abs(x - h.x);
      if (d < bd) { bd = d; best = h.g; }
    }
    return best;
  }

  /** 画面上の点がどの小節か（なければ null） */
  barAt(x, y) {
    const h = this.hits.find(r => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);
    return h ? h.bar : null;
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
