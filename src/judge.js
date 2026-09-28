// 譜面の各音について「弾けたか」を決める。
// 見ているのは「その音の高さの成分が、判定の窓の中で立ち上がったか」。
// ソロギターは和音とベースが重なるので、何が鳴っているかを当てにいくと崩れる。
// 答え（譜面）を知っている側から、答え合わせだけをする。
import { OnsetDetector } from './dsp.js';

export const DEFAULTS = {
  early: 0.15, // 何秒早くまで許すか
  late: 0.2, // 何秒遅くまで許すか
  presentDb: 14, // 雑音の床より何dB上なら「鳴っている」
  riseDb: 8, // 窓の中で何dB立ち上がれば「弾いた」
  riseWithOnsetDb: 3, // アタック（全体の立ち上がり）と重なっていればこれで足りる
  lowPeakDb: 10, // 基音か2倍音が、まわりの谷よりこれだけ高いこと
  neighborDb: 0, // 半音となりより何dB強ければ「その音」
  onsetLinkSec: 0.06,
  // 解析窓の中心で時刻を取ると、アタックが窓に入り始めた時点で検出されるぶん早めに出る
  frameBias: 0,
};

export class Judge {
  constructor(chart, opts = {}) {
    this.chart = chart;
    this.o = { ...DEFAULTS, ...opts };
    this.state = chart.notes.map(() => ({ result: null, delta: 0, minSal: Infinity, open: false }));
    this.cursor = 0; // これより前はもう終わっている
    this.onsets = new OnsetDetector();
    this.waitMode = false;
  }

  /** from 秒以降だけを判定し直す（ループ・途中から） */
  reset(from = 0) {
    this.state = this.chart.notes.map(n => ({ result: n.t < from - 0.001 ? 'skip' : null, delta: 0, minSal: Infinity, open: false }));
    this.cursor = 0;
    this.onsets.reset();
  }

  get lastOnset() { return this.onsets.last; }

  /**
   * 1フレームぶん進める。
   * songTime: 解析窓の中心の曲内時刻（レイテンシ補正済み）
   * spec: Spectrum（analyze 済み）, flux: そのフレームの flux
   * 返り値: このフレームで決まった { id, result: 'hit'|'miss', delta }[]
   */
  step(songTime, spec, flux) {
    const o = this.o;
    const t = songTime - o.frameBias;
    this.onsets.push(t, flux);
    const floor = spec.noiseFloor();
    const out = [];
    const notes = this.chart.notes;
    const hitMidis = new Set();

    while (this.cursor < notes.length && this.state[this.cursor].result) this.cursor++;
    for (let i = this.cursor; i < notes.length; i++) {
      const n = notes[i];
      if (n.t - o.early > t) break;
      const st = this.state[i];
      if (st.result) continue;
      // 装飾音は弾き逃しても失敗にしない（小さく速い音で、聞き取りも弾くのも難しい）。待つ設定でも待たない
      if (n.grace && t > n.t + o.late) { st.result = 'pass'; continue; }
      if (!this.waitMode && t > n.t + o.late) {
        st.result = 'miss';
        out.push({ id: i, result: 'miss', delta: 0 });
        continue;
      }
      if (n.kind === 'dead') {
        if (this.lastOnset >= n.t - o.early && t - this.lastOnset < o.onsetLinkSec) {
          st.result = 'hit'; st.delta = this.lastOnset - n.t;
          out.push({ id: i, result: 'hit', delta: st.delta });
        }
        continue;
      }
      if (hitMidis.has(n.midi)) continue; // 同じ高さの音は、早いほうから1つずつ
      const sal = spec.salience(n.midi);
      if (!st.open) { st.open = true; st.minSal = sal; st.ringing = sal - floor >= o.presentDb; }
      st.minSal = Math.min(st.minSal, sal);
      const present = sal - floor >= o.presentDb && spec.lowPeak(n.midi) >= o.lowPeakDb;
      const distinct = n.kind === 'harmonic' ||
        sal >= Math.max(spec.salience(n.midi - 1), spec.salience(n.midi + 1)) + o.neighborDb;
      const rise = sal - st.minSal;
      const withOnset = t - this.lastOnset < o.onsetLinkSec && this.lastOnset >= n.t - o.early;
      // 鳴らしっぱなしの弦を弾き直すと、その音の成分はほとんど増えない。
      // 窓を開けた時点ですでに鳴っていた音は、アタックと重なっていれば良しとする
      const ok = rise >= o.riseDb || (withOnset && (st.ringing || rise >= o.riseWithOnsetDb));
      if (present && distinct && ok) {
        st.result = 'hit';
        st.delta = t - n.t;
        hitMidis.add(n.midi);
        out.push({ id: i, result: 'hit', delta: st.delta });
        // 同じ高さの次の音は、ここから改めて立ち上がりを見る
        for (let j = i + 1; j < notes.length && notes[j].t < n.t + 2; j++) {
          if (notes[j].midi === n.midi && !this.state[j].result) { this.state[j].open = true; this.state[j].minSal = sal; this.state[j].ringing = true; }
        }
      }
    }
    return out;
  }

  /** 次に弾くべき（まだ決まっていない）いちばん早い音の時刻 */
  nextPendingTime() {
    for (let i = this.cursor; i < this.chart.notes.length; i++) {
      const st = this.state[i];
      if (!st.result && !this.chart.notes[i].grace) return this.chart.notes[i].t;
    }
    return Infinity;
  }
}
