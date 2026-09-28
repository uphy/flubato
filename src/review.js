// 振り返り。弾き終わってから、録音を聞きながらタブ譜の上で「どこがどう悪かったか」を見るための材料を作る。
//
// 練習モード: 追従器の見直し後の道筋から、和音ごとに「止まった・間が空いた・急いだ・戻った・飛ばした」を出し、
//   録音をその和音のところで解析し直して、聞き取れなかった音・小さかった音を出す（判定の取りこぼしも混じる）。
// 音ゲーモード: 1音ずつの判定（早い・遅い・鳴っていない）を和音ごとにまとめる。
//
// 返り値（どちらも同じ形）:
//   { groups: [{ t（録音の何秒目に弾いたか。弾いていなければ null）, marks: [{ kind, text }], notes: Map<noteId, 'missing'|'weak'> }],
//     timeline: [{ t, g }]（時刻順。再生位置からいまの和音を引く）, duration }

import { Spectrum, WINDOW } from './dsp.js';

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const STRING_NAMES = ['1弦', '2弦', '3弦', '4弦', '5弦', '6弦', '7弦', '8弦'];
export const noteName = midi => `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
const noteLabel = n => `${STRING_NAMES[n.string - 1] ?? `${n.string}弦`}${n.fret === 0 ? '開放' : `${n.fret}フレット`}（${noteName(n.midi)}）`;

export const REVIEW_DEFAULTS = {
  lateRatio: 1.5, // 見込みの間隔のこれ倍より空いたら「間が空いた」
  rushRatio: 0.65, // これ倍より詰まったら「急いだ」
  hesitateSec: 1.0, // これより空いたら「止まった」（見込みの2.5倍以上のとき）
  hesitateRatio: 2.5,
  okScore: 0.5, // 音ごとの「弾かれた」らしさ。これ以上なら聞こえた
  weakScore: 0.25, // これ以上なら「鳴ってはいるが弱い（前から鳴っていた音だけかも）」
  gameEarly: 0.07, // 音ゲー: これより早い・遅い（実時間の秒）を出す
  gameLate: 0.09,
};

const emptyGroups = chart => chart.groups.map(() => ({ t: null, marks: [], notes: new Map() }));

/**
 * 練習モードの振り返り。
 * rec: { samples: Float32Array, sampleRate, t0 }（t0 は samples[0] の時刻。追従器に渡した t と同じ時計）
 */
export function practiceReview(chart, follower, rec, opts = {}) {
  const o = { ...REVIEW_DEFAULTS, ...opts };
  const groups = emptyGroups(chart);
  const path = follower.path();
  const events = follower.events;
  const timeline = [];
  const recT = t => t - rec.t0;
  const barNo = g => chart.bars[chart.groups[g].bar].number;
  const ratios = []; // 最近の「実際の間隔 / 譜面の間隔」。いまのテンポの見込みに使う
  const tempo = () => {
    if (!ratios.length) return null;
    const s = [...ratios].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const spec = rec.samples ? new Spectrum(rec.sampleRate) : null;
  const snapAt = t => {
    // 追従器の t は解析の窓の中心
    const c = Math.round((t - rec.t0) * rec.sampleRate);
    const a = c - WINDOW / 2;
    if (a < 0 || a + WINDOW > rec.samples.length) return null;
    spec.analyze(rec.samples.subarray(a, a + WINDOW));
    return spec.snapshot();
  };

  let prev = follower.startPos, lastT = null;
  path.forEach(({ t, pos }, i) => {
    if (pos === prev) return; // 同じところのまま（鳴らし直し・雑音）
    const G = groups[pos];
    timeline.push({ t: recT(t), g: pos });
    G.t = recT(t);
    G.marks = G.marks.filter(m => m.kind === 'skip' || m.kind === 'back'); // 弾き直したら、前の回の間合いは消す
    if (pos < prev) {
      groups[prev].marks.push({ kind: 'back', text: `ここで${barNo(pos)}小節${pos === follower.barStart[pos] ? 'の頭' : ''}へ戻った` });
    } else {
      for (let g = prev + 1; g < pos; g++) if (groups[g].t === null && !chart.groups[g].grace) groups[g].marks.push({ kind: 'skip', text: '飛ばした' });
      if (follower.isNext(prev, pos) && lastT !== null && prev >= 0) {
        const gap = t - lastT;
        const scoreGap = Math.max(0.05, chart.groups[pos].t - chart.groups[prev].t);
        const k = tempo();
        const expected = k === null ? null : scoreGap * k;
        if (gap > o.hesitateSec && (expected === null || gap > o.hesitateRatio * expected)) {
          G.marks.push({ kind: 'hesitate', text: `前で${gap.toFixed(1)}秒止まった` });
        } else if (expected !== null) {
          const r = gap / expected;
          if (r > o.lateRatio) G.marks.push({ kind: 'late', text: `前から間が空いた（見込みの${r.toFixed(1)}倍）` });
          else if (r < o.rushRatio) G.marks.push({ kind: 'rush', text: `急いだ（見込みの${r.toFixed(1)}倍の間隔）` });
          ratios.push(gap / scoreGap);
          if (ratios.length > 8) ratios.shift();
        } else {
          ratios.push(gap / scoreGap);
        }
      }
    }
    // 聞き取れなかった音。答え合わせをしたところを録音から解析し直す
    const ev = events[i];
    G.notes = new Map();
    if (spec && ev.preT != null && ev.postT != null) {
      const pre = snapAt(ev.preT), post = pre && snapAt(ev.postT);
      if (post) {
        spec.withSnapshot(post, () => {
          const scores = follower.noteScores(pos, spec, pre);
          chart.groups[pos].noteIds.forEach((id, k) => {
            if (scores[k] < o.weakScore) G.notes.set(id, 'missing');
            else if (scores[k] < o.okScore) G.notes.set(id, 'weak');
          });
        });
      }
    }
    prev = pos; lastT = t;
  });
  return finish(chart, groups, timeline, rec.samples ? rec.samples.length / rec.sampleRate : 0);
}

/**
 * 音ゲーモードの振り返り。
 * judge: その回の判定器。toRec(songT): 曲内の時刻 → 録音の何秒目に聞こえるはずか。speed: 速さの倍率
 */
export function gameReview(chart, judge, toRec, speed, duration, opts = {}) {
  const o = { ...REVIEW_DEFAULTS, ...opts };
  const groups = emptyGroups(chart);
  const timeline = [];
  chart.groups.forEach((grp, gi) => {
    const st = grp.noteIds.map(id => judge.state[id]);
    if (st.every(s => s.result !== 'hit' && s.result !== 'miss')) return; // 範囲の外
    const G = groups[gi];
    G.t = toRec(grp.t);
    timeline.push({ t: G.t, g: gi });
    grp.noteIds.forEach((id, k) => { if (st[k].result === 'miss') G.notes.set(id, 'missing'); });
    const hits = st.filter(s => s.result === 'hit');
    if (!hits.length) return;
    const d = hits.reduce((a, s) => a + s.delta, 0) / hits.length / speed; // 実時間
    const ms = Math.round(Math.abs(d) * 1000);
    if (d < -o.gameEarly) G.marks.push({ kind: 'rush', text: `${ms}ms 早い` });
    else if (d > o.gameLate) G.marks.push({ kind: 'late', text: `${ms}ms 遅い` });
  });
  return finish(chart, groups, timeline, duration);
}

function finish(chart, groups, timeline, duration) {
  groups.forEach(G => {
    const missing = [], weak = [];
    for (const [id, s] of G.notes) (s === 'missing' ? missing : weak).push(noteLabel(chart.notes[id]));
    if (missing.length) G.marks.push({ kind: 'missing', text: `${missing.join('・')}が聞き取れなかった` });
    if (weak.length) G.marks.push({ kind: 'weak', text: `${weak.join('・')}が小さかった` });
  });
  timeline.sort((a, b) => a.t - b.t);
  return { groups, timeline, duration };
}

/** 再生位置（録音の秒）のときに弾いていた和音 */
export function groupAt(review, t) {
  let g = null;
  for (const e of review.timeline) { if (e.t > t + 0.02) break; g = e.g; }
  return g;
}

/** 「3小節 2つ目: 前で1.8秒止まった。3弦開放（G3）が聞き取れなかった」 */
export function describe(chart, review, g) {
  const grp = chart.groups[g];
  const bar = chart.bars[grp.bar];
  const k = chart.groups.slice(0, g + 1).filter(x => x.bar === grp.bar).length;
  const marks = review.groups[g].marks;
  return `${bar.number}小節 ${k}つ目: ` + (marks.length ? marks.map(m => m.text).join('。') : '問題なし');
}

/** 何かあった和音（時刻順）。「次の問題へ」で使う */
export function issues(review) {
  return review.groups.map((G, g) => ({ g, t: G.t })).filter(x => review.groups[x.g].marks.length)
    .sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity) || a.g - b.g).map(x => x.g);
}

const SPOT_WORDS = { hesitate: '止まった', late: '間が空いた', rush: '急いだ', back: '戻った', skip: '飛ばした' };

/**
 * 苦手な箇所（小節ごと）。「小さかった」だけの小節は判定の取りこぼしが多いので入れない。
 * [{ bar, groups: [g…]（問題のある和音）, summary: '止まった・G3が聞き取れない' }]（小節の順）
 */
export function spots(chart, review) {
  const byBar = new Map();
  review.groups.forEach((G, g) => {
    const real = G.marks.filter(m => m.kind !== 'weak');
    if (!real.length) return;
    const bar = chart.groups[g].bar;
    const s = byBar.get(bar) ?? { bar, groups: [], words: new Set(), notes: new Set() };
    s.groups.push(g);
    for (const m of real) if (SPOT_WORDS[m.kind]) s.words.add(SPOT_WORDS[m.kind]);
    for (const [id, st] of G.notes) if (st === 'missing') s.notes.add(noteName(chart.notes[id].midi));
    byBar.set(bar, s);
  });
  return [...byBar.values()].sort((a, b) => a.bar - b.bar).map(s => ({
    bar: s.bar,
    groups: s.groups,
    summary: [...s.words, ...(s.notes.size ? [`${[...s.notes].join('・')}が聞き取れない`] : [])].join('・'),
  }));
}
