// 練習モードの画面。タブ譜を小節ごとに段組みして、いま弾いているところを光らせる（譜めくり型）。
// 1音ずつ線を通過させる見せ方と違い、小節単位で合っていれば困らない。
// 認識が少し遅れたり迷ったりしても、弾く人は先を読んでいるので止まらずにすむ。

import { drawRhythm, RHYTHM_H } from './rhythm.js';

const MIN_GROUP_PX = 32;
const CLEF_W = 30; // 段の頭の TAB の記号のぶん
const SIG_W = 26; // 拍子記号のぶんの幅
const LEGATO_TAGS = { h: 'H', p: 'P', s: 'S' }; // レガートの弧に添える文字（日本の市販譜と同じ大文字）
const STROKE_W = 0.6; // ストロークの矢印のぶんの幅（和音1つぶんの間隔に対する割合）
const FONT = '-apple-system, system-ui, "Helvetica Neue", sans-serif';
// 色（index.html の CSS と合わせる）
const C = {
  bg: '#0e1016', ink: '#eceef3', played: 'rgba(236,238,243,0.28)', faint: 'rgba(236,238,243,0.38)', clef: 'rgba(236,238,243,0.3)',
  string: 'rgba(255,255,255,0.17)', barline: 'rgba(255,255,255,0.34)', rhythm: 'rgba(236,238,243,0.42)',
  accent: '#ffd24a', accentSoft: 'rgba(255,210,74,0.075)', hover: 'rgba(255,255,255,0.035)',
  bad: '#ff5f74', badSoft: 'rgba(255,95,116,0.13)',
};
// 振り返りで和音の下に出す印
export const MARK_TAGS = { hesitate: '止', late: '間', rush: '急', back: '戻', skip: '飛' };

export class SheetView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scroll = 0; // 表示中の先頭の段（なめらかに動かす）
    // 手で動かしたときの、自動で合わせる先の段。弾いている位置が別の段に移るまでは、手で動かした位置のままにする
    this.manual = null;
    this.vel = 0; // 指で弾いたあとの惰性（段/フレーム）
    this.target = 0; this.maxScroll = 0; this.rowH = 0;
    this.hits = []; // クリック判定用 { x0, x1, y0, y1, bar }
    this.scale = 1; // 利用者が選んだ大きさ（設定の「譜面の大きさ」）
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

  /** 大きさの倍率。スマホの縦持ちのような狭い画面では、1段に小節が2つ入るよう小さめから始める */
  get k() { return (this.w < 600 ? 0.7 : 1) * this.scale; }

  /** 小節を段に割り付ける（幅は中の和音の数で決める） */
  _layout(chart) {
    const k = this.k;
    if (this._rowsFor === chart && this._w === this.w && this._k === k) return this.rows;
    // 狭い画面では、和音どうしの間隔をさらに詰める（数字の大きさのわりに、広い画面の間隔は余白が多い）
    const gx = k * (this.w < 600 ? 0.7 : 1);
    // 横に広い画面でも1段が長くなりすぎないよう、幅に上限を付けて真ん中に置く。左端は TAB の記号のぶん空ける
    const span = Math.min(this.w - (this.w < 600 ? 16 : 48), 1560);
    const left = (this.w - span) / 2 + CLEF_W * k, right = (this.w + span) / 2;
    this.rowLeft = left - CLEF_W * k;
    // 小節の中の横位置: 楽譜の組版と同じく、休符も含めて拍ごとに場所を取り、長い音ほど少し広く（時間の平方根）。
    // 時間に比例させると、休符のあとに短い音が続く小節で数字が右端に詰まって重なる
    this.barPos = new Map();
    const perBar = new Map();
    chart.bars.forEach((bar, i) => {
      const ts = [...new Set([...chart.rhythm.filter(r => r.bar === i).map(r => r.t), ...chart.groups.filter(g => g.bar === i).map(g => g.t)])].sort((a, b) => a - b);
      if (!ts.length) { perBar.set(i, 1); return; }
      const ws = ts.map((t, k) => Math.max(1, Math.sqrt(((ts[k + 1] ?? bar.end) - t) / 0.12)));
      // ストロークの矢印は和音の左に描くので、その前を少し空ける（小節の頭なら小節線との間を）
      const strokes = new Set(chart.groups.filter(g => g.bar === i && g.stroke).map(g => g.t));
      const lead = strokes.has(ts[0]) ? STROKE_W : 0;
      ts.forEach((t, k) => { if (k > 0 && strokes.has(t)) ws[k - 1] += STROKE_W; });
      const total = lead + ws.reduce((a, b) => a + b, 0);
      let acc = lead;
      this.barPos.set(i, { ts, fr: ws.map(w => { const f = acc / total; acc += w; return f; }) });
      perBar.set(i, total * 0.8);
    });
    // 拍子記号は曲の頭と、拍子が変わる小節に、小節線のすぐ右に描く。そのぶん小節の頭を空ける
    this.sigOf = new Map();
    chart.bars.forEach((bar, i) => {
      const prev = chart.bars[i - 1];
      if (bar.num && (!prev || prev.num !== bar.num || prev.den !== bar.den)) this.sigOf.set(i, { num: bar.num, den: bar.den, w: SIG_W * k });
    });
    const rows = [];
    let row = [], x = left;
    chart.bars.forEach((bar, i) => {
      const w = Math.max(120 * gx, ((perBar.get(i) || 1) * MIN_GROUP_PX + 28) * gx) + (this.sigOf.get(i)?.w ?? 0);
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
    // レガート（ハンマリング・プリング・スライド）の弧・斜線を、同じ弦の1つ前の音から引く
    this.prevOnString = new Map();
    // 符尾が上を向く音（声部が2つある小節の、若いほうの声部）。レガートの記号は符尾と重ならないよう、符尾と反対の側に置く
    const upVoice = new Map();
    for (const n of chart.notes) if (chart.bars[n.bar].voiced) upVoice.set(n.bar, Math.min(upVoice.get(n.bar) ?? Infinity, n.voice));
    this.stemUp = n => upVoice.get(n.bar) === n.voice;
    const lastOn = new Map();
    for (const n of chart.notes) {
      if (n.kind === 'legato' && lastOn.has(n.string)) this.prevOnString.set(n.id, lastOn.get(n.string));
      lastOn.set(n.string, n.id);
    }
    // 段の上に線で示す記号（レットリング・ブリッジミュート）が続く和音のまとまり。使っている記号ごとに1本ずつ、下から並べる
    this.spans = [['let ring', n => n.letRing], ['P.M.', n => n.palmMute]]
      .map(([label, has]) => ({ label, runs: runsOf(chart, grp => grp.noteIds.some(id => has(chart.notes[id])) || null) }))
      .filter(sp => sp.runs.length);
    // クレッシェンド・デクレッシェンドが続く和音のまとまり
    this.hairpins = runsOf(chart, grp => grp.hairpin, true);
    this.dynamics = this.hairpins.length > 0 || chart.groups.some(grp => grp.dynamic);
    this.rows = rows;
    this._rowsFor = chart; this._w = this.w; this._k = k;
    return rows;
  }

  /**
   * state: { pos（最後に弾いた group）, played: Uint8Array, conf, listening, stumbleBars: Set, demo（譜面の音を再生している）,
   *   review: { data（review.js の結果）, cursor（再生位置の group）, selected } }（振り返りのときだけ）
   *   song（音ゲーモードでタブ譜を出すときの曲の時刻。この位置に縦線を引き、次に弾く和音もここから決める）
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
    const k = this.k;
    const stringGap = Math.min(24, Math.max(14, areaH / 24)) * k;
    const staffH = stringGap * n1;
    const rhythmH = RHYTHM_H * k;
    const upH = chart.voiced ? rhythmH : 0; // 声部が2つある曲は、上にも上の声部の符尾の段
    const lanes = Math.max(1, this.spans.length); // 段の上の、レットリング・P.M. の線の本数
    const dynH = this.dynamics ? 18 * k : 0; // リズムの下の、強弱記号の段
    // 下にリズム（符尾・連桁）の段と強弱記号の段、段のあいだ
    const rowH = staffH + rhythmH + upH + dynH + stringGap * (2.6 + 0.6 * (lanes - 1)) + 24 * k;
    const padTop = stringGap * (1.6 + 0.6 * lanes) + 8; // 段の上にレットリングなどの線を引くぶん
    const fs = Math.max(9, Math.round(stringGap * 0.8));
    const font = `600 ${fs}px ${FONT}`;
    const graceFont = `600 ${Math.round(fs * 0.72)}px ${FONT}`; // 装飾音は小さく

    const song = state.song ?? null;
    let next = rv ? rv.cursor ?? rv.selected ?? -1
      : song !== null ? nextGroupAt(chart, song)
      : Math.min(chart.groups.length - 1, state.pos + 1);
    // 次に弾くところは本音符で示す（装飾音は弾き逃しても進むので、装飾音で待っているように見せない）
    if (!rv) while (chart.groups[next]?.grace && next < chart.groups.length - 1) next++;
    const curBar = chart.groups[Math.max(0, next)]?.bar ?? 0;
    const curRow = this.rowOfBar.get(curBar) ?? 0;
    // いまの段が上から2段目に来るように（最初は1段目）
    const target = Math.max(0, Math.min(curRow - 1, rows.length - Math.max(1, Math.floor((areaH - padTop) / rowH))));
    // 手で動かせるのは、最後の段が下端に来るところまで
    this.target = target; this.rowH = rowH;
    this.maxScroll = Math.max(target, rows.length - (areaH - padTop) / rowH);
    if (this.manual !== null && this.manual !== target) this.follow();
    if (this.manual === null) {
      this.scroll += (target - this.scroll) * 0.15;
      if (Math.abs(target - this.scroll) < 0.01) this.scroll = target;
    } else if (this.vel) {
      this._scrollTo(this.scroll + this.vel);
      this.vel *= 0.94;
      if (Math.abs(this.vel) < 0.002) this.vel = 0;
    }
    const topOf = ri => padTop + upH + (ri - this.scroll) * rowH;
    const visible = ri => { const t = topOf(ri); return t < areaH + stringGap + upH && t + rowH > 0; };

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
        const text = n.kind === 'dead' ? '×' : n.kind === 'harmonic' ? `<${n.fret}>` : String(n.fret);
        const label = n.ghost ? `(${text})` : text; // ゴーストノートはかっこで囲む
        g.font = n.grace ? graceFont : font;
        const tw = g.measureText(label).width + fs * 0.35;
        const key = `${ri}:${n.string}`;
        if (!gaps.has(key)) gaps.set(key, []);
        gaps.get(key).push([x - tw / 2, x + tw / 2]);
        // レガートは前の音（同じ段になければ少し左）から。H・P・S の文字は隣の弦の線の上に置き、その弦を文字のところで切る。
        // ふだんは上の弦に、符尾が上を向く音なら下の弦に置く
        const p = this.prevOnString.get(id);
        let leg = null;
        if (p !== undefined) {
          const pn = chart.notes[p];
          const px = this.rowOfBar.get(pn.bar) === ri ? this.xAt(chart, pn.bar, pn.t) : x - fs * 2;
          leg = { px, from: pn, tag: LEGATO_TAGS[n.legato], side: this.stemUp(n) ? 1 : -1 };
          const s2 = n.string + leg.side;
          if (leg.tag && s2 >= 1 && s2 <= chart.stringCount) {
            const key2 = `${ri}:${s2}`, mx = (px + x) / 2, lw = fs * 0.5;
            if (!gaps.has(key2)) gaps.set(key2, []);
            gaps.get(key2).push([mx - lw / 2, mx + lw / 2]);
          }
        }
        return { n, id, label, tw, y: top + (n.string - 1) * stringGap, leg };
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
        const upper = top - upH; // 上の声部の符尾の段のぶん上から
        if (isCur || stumble) {
          g.fillStyle = stumble ? C.badSoft : state.listening ? C.accentSoft : C.hover;
          roundRect(g, b.x + 1, upper - stringGap * 1.5, b.w - 2, staffH + upH + stringGap * 1.5 + rhythmH + 8 * k, 8 * k);
          g.fill();
        }
        this.hits.push({ x0: b.x, x1: b.x + b.w, y0: upper - stringGap * 1.6, y1: bot + rhythmH + 8, bar: b.i });
        g.fillStyle = stumble ? C.bad : isCur ? C.accent : C.faint;
        g.font = `700 ${Math.max(9, Math.round(11 * k))}px ${FONT}`;
        g.textAlign = 'left';
        const bar = chart.bars[b.i];
        g.fillText(String(bar.number), b.x + 5 * k, upper - stringGap * 0.75);
        drawDirections(g, bar, bar.jumpTo, b.x + 5 * k + g.measureText(String(bar.number)).width + 6 * k, b.x + b.w - 5 * k,
          upper - stringGap * 0.75, Math.max(10, Math.round(12 * k)), C.accent);
      }
      // 拍子記号（弦の線は記号のところで切る）
      for (const b of row) {
        const sig = this.sigOf.get(b.i);
        if (!sig) continue;
        const sx = b.x + 6 * k + sig.w / 2, sf = Math.round(Math.min(staffH * 0.42, 26 * k));
        for (let s = 1; s <= chart.stringCount; s++) {
          const key = `${ri}:${s}`;
          if (!gaps.has(key)) gaps.set(key, []);
          gaps.get(key).push([sx - sf * 0.45, sx + sf * 0.45]);
        }
        g.font = `600 ${sf}px ${FONT}`; g.textAlign = 'center'; g.fillStyle = C.faint; // 数字より控えめに
        g.fillText(String(sig.num), sx, top + staffH * 0.27);
        g.fillText(String(sig.den), sx, top + staffH * 0.73);
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
      ['T', 'A', 'B'].forEach((c, j) => {
        const y = top + staffH / 2 + (j - 1) * ch * 1.12;
        g.fillStyle = C.bg; g.fillRect(x0 + CLEF_W * k / 2 - ch * 0.5, y - ch * 0.5, ch, ch);
        g.fillStyle = C.clef; g.fillText(c, x0 + CLEF_W * k / 2, y + 0.5);
      });
      // リズムは rhythm.js の寸法のまま描いて、段の下端を原点に k 倍する。符尾は数字の上下の端から
      const o = bot + fs * 0.3, local = y => (y - o) / k;
      const stemFrom = r => {
        if (!r.strings.length) return undefined;
        const s = r.up ? Math.min(...r.strings) : Math.max(...r.strings);
        return local(top + (s - 1) * stringGap + (r.up ? -1 : 1) * fs * 0.55);
      };
      g.save(); g.translate(0, o); g.scale(k, k);
      for (const b of row) {
        drawRhythm(g, chart, chart.rhythm.filter(r => r.bar === b.i), r => this.xAt(chart, b.i, r.t) / k,
          { L: 0, T: local(top - fs * 0.3), stemFrom }, C.rhythm);
      }
      g.restore();
    });

    // 音ゲーモードの再生位置: 曲の時刻どおりに段の上を動く縦線
    if (song !== null && state.listening) {
      const bi = barAtTime(chart, song), ri = this.rowOfBar.get(bi);
      if (ri !== undefined && visible(ri)) {
        const top = topOf(ri), x = this.xAtTime(chart, bi, song);
        g.fillStyle = 'rgba(255,210,74,0.55)';
        g.fillRect(Math.round(x) - 1, top - upH - stringGap * 1.2, 2, staffH + upH + stringGap * 1.2 + rhythmH + 6 * k);
      }
    }

    // 音符
    const pill = (x, top, pad = 0) => roundRect(g, x - fs * 0.78 - pad, top - fs * 0.72 - pad, fs * 1.56 + pad * 2, staffH + fs * 1.44 + pad * 2, fs * 0.7);
    for (const { grp, gi, ri, top, x, notes } of placed) {
      const played = state.played?.[gi];
      // 音ゲーモードは再生位置の縦線があるので、次の和音は囲まない
      const isNext = gi === next && (state.listening || !!rv) && song === null;
      const R = rv?.data.groups[gi];
      this.groupHits.push({ x, y0: top - 8 - upH, y1: top + staffH + 14 + rhythmH, g: gi });
      if (isNext) {
        // 塗りは薄く、数字を黄色にして示す（塗りつぶすと譜面の中で目立ちすぎる）
        g.fillStyle = 'rgba(255,210,74,0.13)'; pill(x, top); g.fill();
        g.strokeStyle = 'rgba(255,210,74,0.5)'; g.lineWidth = 1.2; pill(x, top); g.stroke();
      } else if (rv && gi === rv.selected) {
        g.strokeStyle = C.ink; g.lineWidth = 1.5; pill(x, top); g.stroke();
      } else if (gi === state.pos && state.listening && !state.demo) {
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
      for (const { n, id, label, tw, y, leg } of notes) {
        const heard = R?.notes.get(id); // 'missing' | 'weak'
        const color = isNext ? C.accent
          : skipped || heard === 'missing' || played === 2 ? C.bad
          : played === 1 ? C.played
          : C.ink;
        g.fillStyle = color;
        g.font = n.grace ? graceFont : font;
        g.fillText(label, x, y + 1);
        if (n.bend) this._drawBend(chart, n, x, tw, y - fs * 0.55, top - (chart.bars[grp.bar].voiced ? upH : 0) - stringGap * 0.85, ri, fs, isNext ? C.accent : color);
        if (leg) {
          // レガート: ハンマリング・プリングは弧、スライドは数字のあいだの斜線（上がるなら右上がり）。H・P・S を添える。
          // 弧と文字は、符尾と反対の側に（数字より目立たないよう細く薄く）
          const { px, side } = leg;
          g.strokeStyle = g.fillStyle = isNext ? C.accent : color; g.lineWidth = 1.1; g.globalAlpha = 0.5;
          g.beginPath();
          if (n.legato === 's') {
            const d = (n.fret >= leg.from.fret ? 1 : -1) * fs * 0.28;
            g.moveTo(px + fs * 0.5, y + d); g.lineTo(x - tw / 2, y - d);
          } else {
            const ay = y + side * fs * 0.62;
            g.moveTo(px + fs * 0.3, ay);
            g.quadraticCurveTo((px + x) / 2, ay + side * Math.min(10, (x - px) * 0.15 + 3), x - fs * 0.3, ay);
          }
          g.stroke();
          if (leg.tag) {
            g.font = `600 ${Math.round(fs * 0.7)}px ${FONT}`; g.globalAlpha = 0.55;
            g.fillText(leg.tag, (px + x) / 2, y + side * stringGap + 0.5);
          }
          g.globalAlpha = 1; g.fillStyle = color;
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
      // ストローク: 和音の左に波線の矢印。ダウン（6弦から1弦へ）は上向き、アップは下向き（Guitar Pro のタブ譜と同じ）
      if (grp.stroke) {
        const ys = notes.map(p => p.y), y0 = Math.min(...ys) - fs * 0.55, y1 = Math.max(...ys) + fs * 0.55;
        const sx = x - Math.max(...notes.map(p => p.tw)) / 2 - fs * 0.3, head = fs * 0.32, amp = fs * 0.13, wave = fs * 0.42;
        const [from, to] = grp.stroke.up ? [y0, y1 - head] : [y1, y0 + head];
        g.strokeStyle = g.fillStyle = isNext ? C.accent : played === 1 ? C.played : C.ink;
        g.lineWidth = 1.3; g.beginPath(); g.moveTo(sx, from);
        const dir = Math.sign(to - from), len = Math.abs(to - from);
        for (let d = 0; d <= len; d += 1) g.lineTo(sx + amp * Math.sin((d / wave) * Math.PI * 2), from + dir * d);
        g.stroke();
        const tip = grp.stroke.up ? y1 : y0;
        g.beginPath(); g.moveTo(sx, tip); g.lineTo(sx + head * 0.6, tip - dir * head); g.lineTo(sx - head * 0.6, tip - dir * head); g.closePath(); g.fill();
      }
      // スタッカートの点・テヌートの線・アクセント。和音ごとに1つ、段の上に下から積む（Guitar Pro のタブ譜と同じ置き方）。
      // 上の声部の符尾があれば、その上に
      g.fillStyle = g.strokeStyle = played === 1 && !isNext ? C.played : C.ink;
      let ay = top - (chart.bars[grp.bar].voiced ? upH : 0) - stringGap * 1.25;
      if (notes.some(({ n }) => n.staccato)) {
        g.beginPath(); g.arc(x, ay, Math.max(1.8, fs * 0.13), 0, Math.PI * 2); g.fill();
        ay -= stringGap * 0.5;
      }
      if (notes.some(({ n }) => n.tenuto)) {
        g.fillRect(x - fs * 0.32, ay - 0.75, fs * 0.64, 1.5);
        ay -= stringGap * 0.5;
      }
      const accent = Math.max(0, ...notes.map(({ n }) => n.accent ?? 0));
      if (accent) {
        const w = fs * 0.32, h = fs * 0.22;
        g.lineWidth = 1.5; g.lineJoin = 'round'; g.beginPath();
        if (accent === 2) { g.moveTo(x - h, ay + w * 0.5); g.lineTo(x, ay - w * 0.5); g.lineTo(x + h, ay + w * 0.5); } // ^
        else { g.moveTo(x - w, ay - h); g.lineTo(x + w, ay); g.lineTo(x - w, ay + h); } // >
        g.stroke();
      }
      // 和音の下に、どう悪かったかを1文字で
      const tags = (R?.marks ?? []).map(m => MARK_TAGS[m.kind]).filter(Boolean);
      if (tags.length) {
        const text = tags.join('');
        g.font = `700 11px ${FONT}`;
        const tw = g.measureText(text).width + 8, ty = top + staffH + rhythmH + dynH + 12;
        g.fillStyle = C.badSoft; roundRect(g, x - tw / 2, ty - 8, tw, 16, 4); g.fill();
        g.fillStyle = C.bad; g.fillText(text, x, ty + 0.5);
      }
    }
    const gx = gi => this.xAt(chart, chart.groups[gi].bar, chart.groups[gi].t);
    // 和音のまとまりを段ごとに分ける（段をまたぐときは段ごとに引く）
    const byRow = run => {
      const out = new Map();
      for (const gi of run) {
        const ri = this.rowOfBar.get(chart.groups[gi].bar);
        if (!out.has(ri)) out.set(ri, []);
        out.get(ri).push(gi);
      }
      return [...out].filter(([ri]) => visible(ri)).map(([ri, gis]) => ({
        ri, gis, row: rows[ri], first: gis[0] === run[0], end: gis[gis.length - 1] === run[run.length - 1],
      }));
    };
    // レットリング・P.M.: 続く和音の上に名前と点線を引き、終わりを縦の線で閉じる
    this.spans.forEach(({ label, runs }, lane) => {
      for (const run of runs) for (const { ri, gis, row, first, end } of byRow(run)) {
        const last = row[row.length - 1];
        const y = topOf(ri) - upH - stringGap * (1.95 + 0.6 * lane); // 小節番号と同じく、上の声部の符尾の段の上に
        let x0 = first ? gx(gis[0]) - fs * 0.5 : this.rowLeft + CLEF_W * k;
        let x1 = end ? gx(gis[gis.length - 1]) + fs * 0.9 : last.x + last.w;
        g.fillStyle = g.strokeStyle = C.faint;
        if (first) {
          g.font = `italic 600 ${Math.max(9, Math.round(fs * 0.62))}px ${FONT}`; g.textAlign = 'left';
          g.fillText(label, x0, y);
          x0 += g.measureText(label).width + 4;
        }
        x1 = Math.max(x1, x0 + fs);
        g.lineWidth = 1; g.setLineDash([3, 3]);
        g.beginPath(); g.moveTo(x0, y + 0.5); g.lineTo(x1, y + 0.5); g.stroke();
        g.setLineDash([]);
        if (end) { g.beginPath(); g.moveTo(x1 + 0.5, y - 3); g.lineTo(x1 + 0.5, y + 4); g.stroke(); }
      }
    });
    // 強弱記号とクレッシェンドの記号（<、>）。リズムの段の下に
    if (this.dynamics) {
      const dynY = ri => topOf(ri) + staffH + fs * 0.3 + rhythmH + dynH / 2 + 2 * k;
      const dynFont = `italic 700 ${Math.max(10, Math.round(fs * 0.9))}px Georgia, "Times New Roman", serif`;
      const labelW = gi => { const d = chart.groups[gi].dynamic; if (!d) return 0; g.font = dynFont; return g.measureText(d).width; };
      g.fillStyle = g.strokeStyle = C.rhythm;
      for (const { grp, gi, ri, x } of placed) {
        if (!grp.dynamic) continue;
        g.font = dynFont; g.textAlign = 'center';
        g.fillText(grp.dynamic, x, dynY(ri));
      }
      for (const run of this.hairpins) {
        const dir = chart.groups[run[0]].hairpin, after = run[run.length - 1] + 1;
        for (const { ri, gis, row, first, end } of byRow(run)) {
          const last = row[row.length - 1], y = dynY(ri), h = 5.5 * k;
          const x0 = first ? gx(gis[0]) + (labelW(gis[0]) ? labelW(gis[0]) / 2 + 5 * k : -fs * 0.3) : this.rowLeft + CLEF_W * k;
          // 次の和音が同じ段にあれば、その手前（強弱記号があればその左端の手前）まで
          const next = end && after < chart.groups.length && this.rowOfBar.get(chart.groups[after].bar) === ri;
          let x1 = next ? gx(after) - Math.max(fs * 0.6, labelW(after) / 2 + 5 * k) : end ? gx(gis[gis.length - 1]) + fs : last.x + last.w - 4 * k;
          x1 = Math.max(x1, x0 + fs);
          // 段をまたぐときは、開き具合を段の境目でつなぐ
          const a0 = first ? (dir === '<' ? 0 : 1) : 0.5, a1 = end ? (dir === '<' ? 1 : 0) : 0.5;
          g.lineWidth = 1.2; g.beginPath();
          g.moveTo(x1, y - h * a1); g.lineTo(x0, y - h * a0); g.moveTo(x0, y + h * a0); g.lineTo(x1, y + h * a1);
          g.stroke();
        }
      }
    }
    // 手で動かしている間は、全体のどこを見ているかを右端に出す
    if (this.manual !== null && this.maxScroll > 0) {
      const vis = (areaH - padTop) / rowH, total = this.maxScroll + vis;
      const h = Math.max(24, areaH * vis / total), y = (areaH - h) * this.scroll / this.maxScroll;
      g.fillStyle = 'rgba(255,255,255,0.22)';
      roundRect(g, W - 6, y + 2, 3, h - 4, 1.5); g.fill();
    }
    g.restore();
    g.textAlign = 'left';
  }

  /**
   * チョーキング: 数字の右肩から、上げた音は段の上（yHigh）へ曲線の矢印を引き、上げ幅を書く（Guitar Pro のタブ譜と同じ描き方）。
   * 戻すところは下向きの矢印。上げたまま次の動きまで保つところは点線。プリベンドは数字の上にまっすぐ立てる。
   * 矢印1本の幅は詰めて描き、保つところだけ曲の時刻に合わせてのばす
   */
  _drawBend(chart, n, x, tw, yLow, yHigh, ri, fs, color) {
    const g = this.ctx, head = fs * 0.28, curve = fs * 1.1;
    yHigh = Math.min(yHigh, yLow - fs * 1.1); // 1弦の音でも、上げ下げの矢印が見える長さに
    // 曲の時刻 → 横位置。次の音の数字に重ならないよう少し手前で止め、段の外に出るなら段の右端で止める
    const xOfT = t => {
      let j = n.bar;
      while (j + 1 < chart.bars.length && chart.bars[j + 1].t <= t) j++;
      if (this.rowOfBar.get(j) !== ri) { const row = this.rows[ri], last = row[row.length - 1]; return last.x + last.w - fs * 0.3; }
      return this.xAt(chart, j, t) - fs * 0.6;
    };
    const yOf = semis => semis > 0 ? yHigh : yLow;
    const arrow = (ax, ay, dir) => { // dir: 1 = 上向き
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax - head * 0.55, ay + dir * head); g.lineTo(ax + head * 0.55, ay + dir * head); g.closePath(); g.fill();
    };
    const amount = (ax, semis) => {
      g.font = `600 ${Math.max(9, Math.round(fs * 0.62))}px ${FONT}`; g.textAlign = 'center';
      g.fillText(bendLabel(semis), ax, yHigh - head - fs * 0.35);
    };
    g.save();
    g.strokeStyle = g.fillStyle = color; g.lineWidth = 1.3;
    const pts = n.bend;
    let cx = x + tw / 2; // いまの矢印の根もと
    if (pts[0].semis > 0) {
      // プリベンド: 弾く前に上げておく
      g.beginPath(); g.moveTo(x, yLow); g.lineTo(x, yHigh + head); g.stroke();
      arrow(x, yHigh, 1); amount(x, pts[0].semis);
      cx = x;
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      if (a.semis === b.semis) {
        // 保つ: 次に動くところまで点線（最後まで保つだけなら描かない）
        const moves = pts.slice(i + 1).some(p => p.semis !== b.semis);
        if (a.semis > 0 && moves) {
          const bx = Math.max(cx + fs * 0.3, xOfT(n.t + b.t) - curve);
          g.setLineDash([3, 3]); g.beginPath(); g.moveTo(cx, yHigh); g.lineTo(bx, yHigh); g.stroke(); g.setLineDash([]);
          cx = bx;
        }
        continue;
      }
      const up = b.semis > a.semis, y0 = yOf(a.semis), y1 = yOf(b.semis), bx = cx + curve * (y0 === y1 ? 0.6 : 1);
      g.beginPath(); g.moveTo(cx, y0);
      if (y0 === y1) g.lineTo(bx, y1); // 上げた高さのままさらに上げる・少し戻す
      else { g.quadraticCurveTo(bx, y0, bx, y1 + (up ? head : -head)); }
      g.stroke();
      if (y0 !== y1) arrow(bx, y1, up ? 1 : -1);
      if (up || y0 === y1) amount(bx, b.semis);
      cx = bx;
    }
    g.restore();
  }

  /** 手で譜面を上下に動かす（px、正で先の段へ） */
  scrollBy(px) {
    if (!this.rowH) return;
    this.manual = this.target;
    this._scrollTo(this.scroll + px / this.rowH);
  }

  /** 指で弾いたあとの惰性（px/フレーム）。0 で止める */
  fling(px) {
    if (!this.rowH) return;
    this.vel = px / this.rowH;
  }

  /** 手で動かした位置をやめて、弾いている位置に合わせ直す */
  follow() { this.manual = null; this.vel = 0; }

  _scrollTo(s) {
    this.scroll = Math.max(0, Math.min(this.maxScroll, s));
    if (this.scroll === 0 || this.scroll === this.maxScroll) this.vel = 0;
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
    const lead = this.sigOf.get(i)?.w ?? 0;
    return b.x + 18 * this.k + lead + f * (b.w - 30 * this.k - lead);
  }

  /** 小節 i の中の時刻 t の横位置。xAt と違い、和音と和音のあいだも時刻に比例してなめらかに動く（再生位置の線に使う） */
  xAtTime(chart, i, t) {
    const b = this.boxOf.get(i), bar = chart.bars[i], p = this.barPos.get(i);
    const span = (a, z) => Math.min(1, Math.max(0, (t - a) / Math.max(1e-4, z - a)));
    let f = span(bar.t, bar.end);
    if (p) {
      let k = p.ts.length - 1;
      while (k >= 0 && p.ts[k] > t + 1e-4) k--;
      if (k < 0) f = p.fr[0] * span(bar.t, p.ts[0]);
      else f = p.fr[k] + ((p.fr[k + 1] ?? 1) - p.fr[k]) * span(p.ts[k], p.ts[k + 1] ?? bar.end);
    }
    const lead = this.sigOf.get(i)?.w ?? 0;
    return b.x + 18 * this.k + lead + f * (b.w - 30 * this.k - lead);
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

/**
 * 和音を順に見て、key(和音) が同じ値で続くところを [和音の番号…] のまとまりにする（null ならまとまりの外）。
 * 装飾音だけの和音は、途中にあってもまとまりを切らない。byValue なら値が変わったところでも切る
 */
function runsOf(chart, key, byValue = false) {
  const runs = [];
  let run = null, cur = null;
  chart.groups.forEach((grp, gi) => {
    const v = key(grp);
    if (v !== null && v !== undefined) {
      if (!run || (byValue && v !== cur)) runs.push(run = []);
      run.push(gi); cur = v;
    } else if (!grp.grace) run = null;
  });
  return runs;
}

/** 時刻 t を含む小節（曲の前なら最初、後なら最後の小節） */
function barAtTime(chart, t) {
  let lo = 0, hi = chart.bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (chart.bars[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** 時刻 song でいま弾く和音: まだ過ぎていない最初の本音符の和音（ちょうど弾いている和音は少しのあいだ残す） */
function nextGroupAt(chart, song) {
  const gs = chart.groups;
  let lo = 0, hi = gs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (gs[mid].t < song - 0.06) lo = mid + 1; else hi = mid;
  }
  while (gs[lo]?.grace && lo < gs.length - 1) lo++;
  return Math.min(lo, gs.length - 1);
}

/** チョーキングの上げ幅の書き方（全音 = full、半音 = 1/2 …）。Guitar Pro のタブ譜と同じ */
function bendLabel(semis) {
  const q = Math.round(semis * 2); // 1/4 音単位
  if (q === 4) return 'full';
  const whole = Math.floor(q / 4), frac = ['', '¼', '½', '¾'][q % 4];
  return whole ? `${whole}${frac}` : frac;
}

/**
 * D.S.・コーダの記号を書く。目印（𝄋・Coda）は小節番号の右、飛ぶ指示（D.S. al Coda・To Coda）は小節の右端。
 * 譜面は弾く順に並べているので、この回に実際に飛ぶなら飛び先の小節番号（→ 57）を足す（jumpTo。飛ばない回は null）
 */
export function drawDirections(g, bar, jumpTo, xStart, xEnd, y, px, color) {
  const { start } = bar.directions;
  const end = [...bar.directions.end];
  if (jumpTo != null && end.length > 0) end[end.length - 1] += ` → ${jumpTo}`;
  if (start.length === 0 && end.length === 0) return;
  g.save();
  g.fillStyle = color; g.strokeStyle = color;
  g.font = `700 ${px}px ${FONT}`;
  g.textBaseline = 'alphabetic';
  let x = xStart;
  for (const s of start) x = drawTarget(g, s, x, y, px) + px * 0.5;
  g.textAlign = 'right';
  if (end.length) g.fillText(end.join(' '), xEnd, y);
  g.restore();
}

/** 目印の記号を x（左端）から描き、右端の x を返す。y は文字の並びの下（ベースライン） */
function drawTarget(g, kind, x, y, px) {
  const h = px * 1.1; // 記号の高さ
  const cy = y - h / 2 + px * 0.05;
  g.lineWidth = Math.max(1.2, px * 0.11);
  g.textAlign = 'left';
  if (kind === 'fine') { g.fillText('Fine', x, y); return x + g.measureText('Fine').width; }
  const count = kind.endsWith('2') ? 2 : 1;
  const w = kind.startsWith('segno') ? h * 0.62 : h;
  for (let i = 0; i < count; i++) {
    const cx = x + w / 2;
    if (kind.startsWith('segno')) {
      // S の字に斜線、左下と右上に点
      g.font = `italic 700 ${Math.round(h * 1.05)}px Georgia, "Times New Roman", serif`;
      g.textAlign = 'center';
      g.fillText('S', cx, y + px * 0.08);
      g.beginPath(); g.moveTo(cx - w * 0.55, y + px * 0.05); g.lineTo(cx + w * 0.55, y - h + px * 0.05); g.stroke();
      for (const [dx, dy] of [[-0.45, -0.3], [0.45, 0.3]]) {
        g.beginPath(); g.arc(cx + dx * w, cy + dy * h, Math.max(1.3, px * 0.1), 0, Math.PI * 2); g.fill();
      }
    } else {
      // 楕円に十字
      g.beginPath(); g.ellipse(cx, cy, w * 0.3, h * 0.36, 0, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(cx, cy - h * 0.55); g.lineTo(cx, cy + h * 0.55); g.moveTo(cx - w * 0.5, cy); g.lineTo(cx + w * 0.5, cy); g.stroke();
    }
    x += w + px * 0.15;
  }
  if (kind.startsWith('coda')) {
    g.font = `700 ${px}px ${FONT}`; g.textAlign = 'left';
    g.fillText('Coda', x + px * 0.1, y);
    x += px * 0.1 + g.measureText('Coda').width;
  }
  return x;
}
