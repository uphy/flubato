// 描画。上がタブ譜と同じ向き（いちばん上が1弦）のレーンで、音符が右から流れてくる。

import { drawRhythm, RHYTHM_H } from './rhythm.js';

export const STRING_COLORS = ['#c08bff', '#4fdc86', '#ffa24a', '#52a8ff', '#ffd84a', '#ff6275', '#5ee0d8', '#b0b6c4'];
const BG = '#0e1016';
const FONT = '-apple-system, system-ui, "Helvetica Neue", sans-serif';
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export class View {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pps = 240; // 1秒あたりのピクセル
    this.effects = []; // { t0, x, y, color, kind }
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  layout(stringCount, voiced = false) {
    // 背の高い画面で弦の間隔を広げすぎると、目を上下に大きく動かすことになる。
    // 間隔に上限を付けて、レーンを縦の真ん中に置く
    // スマホの縦持ち（幅が狭い）では、横に流れる時間が足りない。弦を詰めて判定ラインを左に寄せる
    const narrow = this.w < 600;
    const upH = voiced ? RHYTHM_H : 0; // 声部が2つある曲は、上にも上の声部の符尾の段
    const pad = this.h < 400 ? 12 : 40; // 上下の余白。背の低い画面（スマホの横持ち）では詰めて、弦の間隔（数字の大きさ）に回す
    const gap = Math.max(18, Math.min(narrow ? 30 : 54, (this.h - 34 - upH - RHYTHM_H - pad) / stringCount));
    const lanesH = gap * stringCount;
    const top = Math.max(0, (this.h - (34 + upH + lanesH + RHYTHM_H + 20)) / 2); // 下にリズム（符尾・連桁）の段
    const laneTop = top + 34 + upH;
    const noteH = Math.min(36, gap * 0.74);
    const lanes = [];
    for (let i = 0; i < stringCount; i++) lanes.push(laneTop + gap * (i + 0.5));
    return {
      top, bottom: laneTop + lanesH + RHYTHM_H + 6, lanes, gap,
      hitX: narrow ? 66 : Math.max(120, this.w * 0.22), noteH,
      // 1秒あたりのピクセル。音符が小さい（弦を詰めた）画面では、音符の大きさに合わせて流れる速さを落とす。
      // 速さが同じだと、小さな数字が速く流れて読み取れない（音符の間隔の設定はこの速さに掛かる）
      pps: this.pps * Math.min(1, noteH / 36),
    };
  }

  hitFx(note, L, now) {
    this.effects.push({ t0: now, x: L.hitX, y: L.lanes[note.string - 1], color: STRING_COLORS[note.string - 1] });
  }

  /**
   * opts: { loop: { from, to }（くり返しの範囲）, countIn: { k（何拍目）, n（何拍数えるか）}（数える間だけ）,
   *         playing（進んでいる間だけ、拍で判定ラインを光らせる） }
   */
  draw(chart, judge, song, now, opts = {}) {
    const g = this.ctx, W = this.w, H = this.h;
    const L = this.layout(chart.stringCount, chart.voiced);
    g.clearRect(0, 0, W, H);
    g.fillStyle = BG;
    g.fillRect(0, 0, W, H);
    const xOf = t => L.hitX + (t - song) * L.pps;
    const nh = L.noteH, nw = Math.max(nh * 1.2, 24); // 音符の高さと幅
    const tMin = song - L.hitX / L.pps - 0.5, tMax = song + (W - L.hitX) / L.pps + 0.5;
    // 装飾音は本音符とほとんど同じ時刻なので、そのまま置くと本音符の箱に重なって隠してしまう。
    // 小さく描いて本音符の左に並べる（和音のつなぎ線もこの位置に引く）
    const gh = nh * 0.62, gw = Math.max(gh * 1.2, 18);
    const graceX = n => {
      const main = chart.groups[n.group + n.grace.slot + 1];
      return main ? Math.min(xOf(n.t), xOf(main.t) - nw / 2 - gw / 2 - 3 - n.grace.slot * (gw + 3)) : xOf(n.t);
    };
    const yTop = L.lanes[0] - L.gap / 2, yBot = L.lanes[L.lanes.length - 1] + L.gap / 2;

    // レーンの地（弦ごとに薄く交互）
    L.lanes.forEach((y, i) => {
      if (i % 2) { g.fillStyle = 'rgba(255,255,255,0.018)'; g.fillRect(0, y - L.gap / 2, W, L.gap); }
    });

    // ループ範囲の外は暗く
    if (opts.loop) {
      g.fillStyle = 'rgba(0,0,0,0.45)';
      const a = xOf(opts.loop.from), b = xOf(opts.loop.to);
      if (a > 0) g.fillRect(0, L.top, Math.min(W, a), L.bottom - L.top);
      if (b < W) g.fillRect(Math.max(0, b), L.top, W - Math.max(0, b), L.bottom - L.top);
    }

    // 判定の窓（この幅のうちに弾けば当たり）
    if (judge) {
      const a = L.hitX - judge.o.late * L.pps, b = L.hitX + judge.o.early * L.pps;
      const grad = g.createLinearGradient(a, 0, b, 0);
      grad.addColorStop(0, 'rgba(255,210,74,0)'); grad.addColorStop(0.5, 'rgba(255,210,74,0.07)'); grad.addColorStop(1, 'rgba(255,210,74,0)');
      g.fillStyle = grad; g.fillRect(a, yTop, b - a, yBot - yTop);
    }

    // 小節線
    g.font = `700 12px ${FONT}`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    // 拍の線は引かない。拍の区切りはリズムの段の連桁で読め、音符の真ん中を通る線は符尾と見分けにくい
    // 小節線は1拍目の音符の手前に引く（五線譜と同じ）。音符に重ねると、上の声部の符尾・小節線・下の声部の符尾が
    // 1本の線につながって見える
    for (const bar of chart.bars) {
      if (bar.t < tMin - 10 || bar.t > tMax) continue;
      const x = Math.round(xOf(bar.t) - nw / 2 - 6);
      // 1弦から6弦までのあいだだけに、弦より目立たない濃さで
      const y0 = L.lanes[0], y1 = L.lanes[L.lanes.length - 1];
      g.fillStyle = 'rgba(255,255,255,0.16)';
      g.fillRect(x, y0, 1, y1 - y0);
      g.fillStyle = 'rgba(236,238,243,0.45)';
      g.fillText(String(bar.number), x + 6, yTop - 12 - (chart.voiced ? RHYTHM_H : 0));
    }

    // 弦（低い弦ほど太く）
    L.lanes.forEach((y, i) => {
      g.strokeStyle = STRING_COLORS[i] + '66';
      g.lineWidth = 1 + i * 0.35;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    });

    // リズム（見えている小節ぶん。連符の数字の区切りが画面の端でずれないように小節ごと）
    const visBars = new Set(chart.bars.map((b, i) => (b.end >= tMin && b.t <= tMax ? i : -1)).filter(i => i >= 0));
    // 符尾は音符の上下の端から（音符は後から重ねて描く）
    const stemFrom = r => {
      if (!r.strings.length) return undefined;
      const s = r.up ? Math.min(...r.strings) : Math.max(...r.strings);
      return L.lanes[s - 1] + (r.up ? -1 : 1) * L.noteH / 2;
    };
    drawRhythm(g, chart, chart.rhythm.filter(r => visBars.has(r.bar)), r => xOf(r.t), { L: yBot - 4, T: yTop + 4, stemFrom }, 'rgba(236,238,243,0.4)');

    // 和音のつなぎ線。声部ごとに引く（メロディと低音をつなぐと、1つの和音に見える）
    for (const grp of chart.groups) {
      if (grp.t < tMin || grp.t > tMax || grp.noteIds.length < 2) continue;
      const ns = grp.noteIds.map(id => chart.notes[id]);
      const x = grp.grace ? graceX(ns[0]) : xOf(grp.t);
      g.strokeStyle = 'rgba(255,255,255,0.28)';
      g.lineWidth = grp.grace ? 1.5 : 2;
      for (const v of new Set(ns.map(n => n.voice))) {
        const ys = ns.filter(n => n.voice === v).map(n => L.lanes[n.string - 1]);
        if (ys.length < 2) continue;
        g.beginPath(); g.moveTo(x, Math.min(...ys)); g.lineTo(x, Math.max(...ys)); g.stroke();
      }
    }

    // 音符（後ろから描く）
    g.font = `700 ${Math.round(nh * 0.62)}px ${FONT}`;
    g.textAlign = 'center';
    // 装飾音を先に、本音符をあとから（上に）描く
    const drawNote = (i, n) => {
      const st = judge?.state[i];
      const res = st?.result;
      if (res === 'skip') return;
      const color = STRING_COLORS[n.string - 1];
      const y = L.lanes[n.string - 1];
      if (n.grace) { drawGrace(g, n, res, graceX(n), y, gw, gh, color, song); return; }
      const x = xOf(n.t);
      // のばし
      if (n.dur > 0.3) {
        g.fillStyle = res === 'miss' ? 'rgba(120,120,130,0.3)' : color + '40';
        roundRect(g, x, y - 3, n.dur * L.pps, 6, 3); g.fill();
      }
      let alpha = 1;
      if (res === 'hit') alpha = Math.max(0, 1 - (song - n.t) * 2.5);
      if (alpha <= 0) return;
      g.globalAlpha = alpha;
      if (res !== 'miss' && res !== 'hit') { g.save(); g.shadowColor = color + '88'; g.shadowBlur = 10; }
      g.fillStyle = res === 'miss' ? '#3a3e4a' : res === 'hit' ? '#ffffff' : color;
      roundRect(g, x - nw / 2, y - nh / 2, nw, nh, nh * 0.32);
      g.fill();
      if (res !== 'miss' && res !== 'hit') g.restore();
      g.fillStyle = res === 'hit' ? color : res === 'miss' ? '#8a90a0' : '#10121a';
      const label = n.kind === 'dead' ? '×' : n.kind === 'harmonic' ? `<${n.fret}>` : String(n.fret);
      g.fillText(label, x, y + 1);
      if (n.kind === 'legato') {
        g.strokeStyle = '#ffffffaa'; g.lineWidth = 1.5;
        // 同じ弦の装飾音からのハンマリング・スライドは、装飾音から本音符へ弧を渡す
        const from = n.group > 0 && chart.groups[n.group - 1].grace
          && chart.groups[n.group - 1].noteIds.map(id => chart.notes[id]).find(o => o.string === n.string);
        g.beginPath();
        if (from) {
          const x0 = graceX(from), y0 = y - Math.max(gh, nh) / 2 - 2;
          g.moveTo(x0, y - gh / 2 - 2); g.quadraticCurveTo((x0 + x) / 2, y0 - 10, x - nw / 4, y - nh / 2 - 2);
        } else g.arc(x - nw / 2 - 2, y - nh / 2 - 2, 5, Math.PI, 1.5 * Math.PI);
        g.stroke();
      }
      g.globalAlpha = 1;
    };
    const shown = n => n.t + n.dur >= tMin && n.t <= tMax;
    g.font = `700 ${Math.round(gh * 0.66)}px ${FONT}`;
    for (let i = chart.notes.length - 1; i >= 0; i--) if (chart.notes[i].grace && shown(chart.notes[i])) drawNote(i, chart.notes[i]);
    g.font = `700 ${Math.round(nh * 0.62)}px ${FONT}`;
    for (let i = chart.notes.length - 1; i >= 0; i--) if (!chart.notes[i].grace && shown(chart.notes[i])) drawNote(i, chart.notes[i]);

    // 判定ラインより左（もう過ぎたところ）は暗く
    const past = g.createLinearGradient(0, 0, L.hitX, 0);
    past.addColorStop(0, 'rgba(14,16,22,0.85)'); past.addColorStop(1, 'rgba(14,16,22,0.25)');
    g.fillStyle = past; g.fillRect(0, yTop - 24, L.hitX, yBot - yTop + 48);

    // 判定ライン。拍が通るたびに太く光らせ、少しずつ戻す（小節の頭はカウントと同じ黄色）。
    // 目の置き場所で拍が分かるので、スピーカーのクリックに頼らずに済む
    const bt = opts.playing ? lastBeat(chart.beats, song) : null;
    const p = bt ? Math.max(0, 1 - (song - bt.t) / PULSE_SEC) : 0;
    const w = 4 + 4 * p;
    g.save();
    g.shadowColor = bt?.first && p > 0 ? `rgba(255,210,74,${0.6 + 0.4 * p})` : `rgba(255,255,255,${0.6 + 0.4 * p})`;
    g.shadowBlur = 12 + 18 * p;
    g.fillStyle = 'rgba(255,255,255,0.92)';
    roundRect(g, L.hitX - w / 2, yTop - 6 - 4 * p, w, yBot - yTop + 12 + 8 * p, w / 2); g.fill();
    if (bt?.first && p > 0) { g.fillStyle = `rgba(255,210,74,${p})`; g.fill(); }
    g.restore();

    // 左端の弦の名前（開放弦の音）。流れてきた音符の上に重ねる
    g.fillStyle = BG; g.fillRect(0, yTop - 24, 44, yBot - yTop + 48);
    L.lanes.forEach((y, i) => {
      const r = Math.min(12, L.gap * 0.36);
      g.fillStyle = BG; g.beginPath(); g.arc(22, y, r + 3, 0, Math.PI * 2); g.fill();
      g.strokeStyle = STRING_COLORS[i]; g.lineWidth = 1.5;
      g.beginPath(); g.arc(22, y, r, 0, Math.PI * 2); g.stroke();
      g.fillStyle = STRING_COLORS[i];
      g.font = `700 ${Math.round(r * 0.95)}px ${FONT}`;
      g.textAlign = 'center';
      g.fillText(chart.tuning ? NAMES[(chart.tuning[i] + (chart.capo || 0)) % 12] : String(i + 1), 22, y + 0.5);
    });

    // 当たったときの輪
    this.effects = this.effects.filter(e => now - e.t0 < 0.35);
    for (const e of this.effects) {
      const k = (now - e.t0) / 0.35;
      g.strokeStyle = e.color;
      g.globalAlpha = 1 - k;
      g.lineWidth = 4 * (1 - k) + 1;
      g.beginPath(); g.arc(e.x, e.y, nh * 0.5 + k * 26, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1;
    }

    if (opts.countIn) drawCountIn(g, W, H, opts.countIn);
    g.textAlign = 'left';
  }
}

/** カウント（1小節ぶん）。1, 2, 3 と数え上げ、何拍数えるかを点で見せる。音ゲーモードのタブ譜の表示でも使う */
export function drawCountIn(g, W, H, { k, n }) {
  const size = Math.round(Math.min(140, H * 0.26));
  g.save();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = 'rgba(14,16,22,0.82)';
  g.fillRect(0, 0, W, H);
  g.fillStyle = k === n ? '#ffffff' : '#ffd24a';
  g.font = `800 ${size}px ${FONT}`;
  g.fillText(String(k), W / 2, H / 2);
  const r = 7, gap = 26, y = H / 2 + size * 0.7;
  for (let i = 1; i <= n; i++) {
    const x = W / 2 + (i - (n + 1) / 2) * gap;
    g.beginPath(); g.arc(x, y, i === 1 ? r + 1.5 : r, 0, Math.PI * 2);
    if (i <= k) { g.fillStyle = '#ffd24a'; g.fill(); }
    else { g.strokeStyle = 'rgba(255,210,74,0.5)'; g.lineWidth = 1.5; g.stroke(); }
  }
  g.restore();
}

const PULSE_SEC = 0.15; // 拍で光った判定ラインが元に戻るまで（曲の秒）

/** song 以前でいちばん新しい拍 */
function lastBeat(beats, song) {
  let lo = 0, hi = beats.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid].t <= song) { found = beats[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
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

/** 装飾音: 小さな箱。弾き逃しても失敗の色にはしない（res === 'pass'） */
function drawGrace(g, n, res, x, y, w, h, color, song) {
  let alpha = res === 'pass' ? 0.4 : 0.9;
  if (res === 'hit') alpha = Math.max(0, 1 - (song - n.t) * 2.5);
  if (alpha <= 0) return;
  g.globalAlpha = alpha;
  g.fillStyle = res === 'hit' ? '#ffffff' : color;
  roundRect(g, x - w / 2, y - h / 2, w, h, h * 0.32);
  g.fill();
  g.fillStyle = res === 'hit' ? color : '#10121a';
  g.fillText(n.kind === 'dead' ? '×' : n.kind === 'harmonic' ? `<${n.fret}>` : String(n.fret), x, y + 1);
  // 装飾音の印（左上の角に斜線）。右上に付けると本音符とのすき間に出て、本音符に隠れたり弧と重なったりする
  g.strokeStyle = '#ffffffcc'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(x - w / 2 - 4, y - h / 2 + 4); g.lineTo(x - w / 2 + 4, y - h / 2 - 4); g.stroke();
  g.globalAlpha = 1;
}
