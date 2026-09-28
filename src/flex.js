// 音ゲーモードの「テンポを合わせる」。
// ソロギターはテンポが揺れる（溜める・走る）ので、譜面どおりの一定のテンポに合わせて弾くと急かされる。
// 曲の時計を人に寄せる。人がいまどこを弾いたかは、練習モードの追従器（follow.js）で見る:
//   - 判定（judge.js）は時計の窓が開いてからしか音を拾わないので、人が先に弾くと、その時刻が時計に引きずられる。
//     追従器はアタックから位置を決めるので、時計に関係なく「いつ・どこを弾いたか」が分かる
//   - テンポ: 追従器が見積もった、実際の間隔と譜面の間隔の比に寄せる
//   - 位置: 和音に入ったアタックの時刻に、時計がその和音の時刻を指していたかを見て、ずれを少しずつ返す
//   - 待つ: 次の和音の時刻を過ぎても弾かれていなければ、判定の窓の終わりに向けて時計をゆるめる（溜め・フェルマータ）
// 判定そのものは変えない。時計の進み方だけを変える。
import { Follower } from './follow.js';

export const FLEX_DEFAULTS = {
  tempoGain: 0.35, // 追従器の見積もったテンポへ、1回でどれだけ寄せるか
  phaseGain: 0.6, // 位置のずれを、どれだけ時計に返すか
  phaseMax: 0.4, // 1回の位置の直しの上限（曲の秒）
  confMin: 0.4, // 追従器がこれより迷っているときの位置は使わない
  kMin: 0.5, kMax: 1.6, // テンポの倍率の範囲
  waitMin: 0.12, // 待つときに、時計をどこまでゆるめるか（速さの倍率）
  phaseRate: 10, // ずれの直しを、1秒あたりどれだけの割合で進めるか（一度に跳ばさない）
};

export class FlexClock {
  /** from: 始める曲の時刻 */
  constructor(chart, judge, from = 0, opts = {}) {
    this.chart = chart;
    this.judge = judge;
    this.o = { ...FLEX_DEFAULTS, ...opts };
    this.k = 1; // テンポの倍率（1 = 譜面どおり）
    this.phase = 0; // これから時計に足す、曲の秒
    this.follower = new Follower(chart);
    this.follower.start(Math.max(0, chart.groups.findIndex(g => g.t >= from - 1e-6)));
  }

  /** 1フレーム進める。t: そのフレームの実時間の秒, songAt(t): 実時間 → そのときの曲の時刻, speed: 速さの設定 */
  step(t, songAt, spec, flux, speed) {
    const f = this.follower, ev = f.step(t, spec, flux);
    if (!ev || (ev.kind !== 'next' && ev.kind !== 'skip') || ev.conf < this.o.confMin) return;
    const target = 1 / (f.tempo * speed);
    this.k = clamp(this.k + this.o.tempoGain * (target - this.k), this.o.kMin, this.o.kMax);
    const err = this.chart.groups[ev.pos].t - songAt(ev.t);
    this.phase += this.o.phaseGain * clamp(err, -this.o.phaseMax, this.o.phaseMax);
  }

  /** いまの曲の時刻 song で、時計の進む速さ（速さの設定に掛ける倍率） */
  rate(song) {
    let rate = this.k;
    let g = this.follower.pos + 1;
    // 装飾音は弾き逃しても待たない（その先の本音符で待つ）
    while (this.chart.groups[g]?.noteIds.every(id => this.chart.notes[id].grace)) g++;
    const grp = this.chart.groups[g];
    // 次の和音の時刻を過ぎたのに、追従器も判定もまだ弾いたと見ていなければ、待つ
    if (grp && song > grp.t && !grp.noteIds.some(id => this.judge.state[id].result === 'hit')) {
      rate *= Math.max(this.o.waitMin, 1 - (song - grp.t) / this.judge.o.late);
    }
    return rate;
  }

  /** dt 秒ぶんの位置の直し（曲の秒）。時計に足す */
  takePhase(dt) {
    const d = this.phase * Math.min(1, dt * this.o.phaseRate);
    this.phase -= d;
    return d;
  }
}

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
