// テスト用：人っぽい演奏を作る。テンポが揺れる・止まる・弾き直す・飛ばす・間違える。
import { Spectrum, WINDOW, HOP } from '../src/dsp.js';
import { Follower } from '../src/follow.js';
import { render, SR } from './synth.mjs';

/**
 * script: { from, to, tempo(i)→倍率, pause: {g: 秒}, back: {g: 戻り先g}（g を弾いたあと戻る）, skip: Set<g>, wrong: Set<g>（g の代わりに違う音）}
 * 返り値: { steps: [{ g, t, wrong }], plays, duration }
 */
export function perform(chart, script = {}) {
  const { from = 0, to = chart.groups.length - 1, tempo = () => 1, pause = {}, back = {}, skip = new Set(), wrong = new Set(), lead = 1 } = script;
  const steps = [];
  const plays = [];
  let t = lead;
  let g = from;
  const backDone = new Set();
  let guard = 0;
  while (g <= to && guard++ < 10000) {
    if (pause[g]) t += pause[g];
    if (!skip.has(g)) {
      const isWrong = wrong.has(g);
      for (const id of chart.groups[g].noteIds) {
        const n = chart.notes[id];
        plays.push({ t, midi: isWrong ? n.midi + 5 + (id % 3) : n.midi, string: n.string, amp: n.string >= 5 ? 0.4 : 0.25 });
      }
      steps.push({ g, t, wrong: isWrong });
    }
    const nextG = back[g] !== undefined && !backDone.has(g) ? back[g] : g + 1;
    if (back[g] !== undefined) backDone.add(g);
    const gap = g + 1 < chart.groups.length ? chart.groups[g + 1].t - chart.groups[g].t : 0.5;
    t += Math.max(0.08, gap * tempo(g));
    if (nextG <= g) t += 0.6; // 戻るときは少し間が空く
    g = nextG;
  }
  return { steps, plays, duration: t + 1 };
}

/** 演奏を追従器に流し、各ステップの少しあとで位置が合っていたかを見る */
export function follow(chart, perf, { from = 0, opts = {}, check = 0.2, room = {} } = {}) {
  const audio = render(perf.plays, perf.duration, room);
  const spec = new Spectrum(SR);
  const f = new Follower(chart, opts);
  f.start(from);
  const trace = [];
  for (let end = WINDOW; end <= audio.length; end += HOP) {
    const { flux } = spec.analyze(audio.subarray(end - WINDOW, end));
    const t = (end - WINDOW / 2) / SR;
    const ev = f.step(t, spec, flux);
    trace.push({ t, pos: f.pos });
  }
  const posAt = time => { let p = from - 1; for (const x of trace) { if (x.t > time) break; p = x.pos; } return p; };
  const judged = perf.steps.filter(s => !s.wrong);
  const correct = judged.filter(s => posAt(s.t + check) === s.g).length;
  const barOf = g => (g < 0 ? -1 : chart.groups[g].bar);
  const barCorrect = judged.filter(s => barOf(posAt(s.t + check)) === barOf(s.g)).length;
  return { follower: f, rate: correct / judged.length, barRate: barCorrect / judged.length, final: f.pos, posAt, trace };
}
