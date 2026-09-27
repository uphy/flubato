// チューナー。マイクの波形から、いま鳴っている音の高さ（1つだけ）を McLeod の方法（NSDF）で測る。
// 練習・音ゲーの判定（dsp.js）は「譜面の音が鳴ったか」を見るだけなので、音の高さそのものはここで測る。

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MIN_HZ = 60; // 6弦を D まで下げても測れる
const MAX_HZ = 1400; // 1弦の20フレットあたりまで

/** 周波数 → いちばん近い音と、そこからのずれ（セント） */
export function noteOf(hz, a4 = 440) {
  const m = 69 + 12 * Math.log2(hz / a4);
  const midi = Math.round(m);
  return { midi, name: NAMES[((midi % 12) + 12) % 12], octave: Math.floor(midi / 12) - 1, cents: (m - midi) * 100 };
}

/**
 * x の中の音の高さ。見つからない（無音・雑音・和音でばらばら）なら null。
 * clarity は周期の揃い具合（0〜1）。1 に近いほど1つの音がはっきり鳴っている
 */
export function detectPitch(x, sampleRate) {
  const n = x.length;
  const minLag = Math.floor(sampleRate / MAX_HZ);
  const maxLag = Math.min(Math.ceil(sampleRate / MIN_HZ), n >> 1);
  let energy = 0;
  for (let i = 0; i < n; i++) energy += x[i] * x[i];
  if (Math.sqrt(energy / n) < 0.003) return null;

  // NSDF: 2Σx[i]x[i+τ] / Σ(x[i]² + x[i+τ]²)。周期の整数倍の τ で 1 に近い山になる
  const nsdf = new Float32Array(maxLag + 2);
  for (let tau = minLag; tau <= maxLag + 1; tau++) {
    let r = 0, m = 0;
    for (let i = 0, e = n - tau; i < e; i++) {
      const a = x[i], b = x[i + tau];
      r += a * b; m += a * a + b * b;
    }
    nsdf[tau] = m > 0 ? 2 * r / m : 0;
  }

  // 正の区間ごとの山を集め、いちばん高い山の 0.9 倍を超える最初の山を周期とする（2倍・3倍の周期を選ばない）
  const peaks = [];
  let tau = minLag;
  while (tau <= maxLag && nsdf[tau] > 0) tau++; // 0 のずれのまわりの山は飛ばす
  while (tau <= maxLag) {
    while (tau <= maxLag && nsdf[tau] <= 0) tau++;
    let best = -1;
    while (tau <= maxLag && nsdf[tau] > 0) {
      if (best < 0 || nsdf[tau] > nsdf[best]) best = tau;
      tau++;
    }
    if (best > 0) peaks.push(best);
  }
  if (peaks.length === 0) return null;
  const top = Math.max(...peaks.map(p => nsdf[p]));
  const p = peaks.find(p => nsdf[p] >= 0.9 * top);
  // 山の前後3点を放物線で結んで、周期を1サンプルより細かく出す
  const a = nsdf[p - 1], b = nsdf[p], c = nsdf[p + 1];
  const d = a - 2 * b + c;
  const shift = d < 0 ? 0.5 * (a - c) / d : 0;
  const clarity = b - 0.25 * (a - c) * shift;
  if (clarity < 0.8) return null;
  return { hz: sampleRate / (p + shift), clarity };
}

/** マイクの波形をためて、音の高さを測る。表示が揺れないよう、直近の数回の中央値を返す */
export class Tuner {
  constructor(sampleRate, size = 4096) {
    this.sampleRate = sampleRate;
    this.buf = new Float32Array(size);
    this.filled = 0;
    this.recent = []; // 直近の測った周波数
    this.lastAt = -Infinity; // 最後に音が測れた時刻（ms）
  }

  push(data) {
    const b = this.buf;
    if (data.length >= b.length) { b.set(data.subarray(data.length - b.length)); this.filled = b.length; return; }
    const keep = Math.min(this.filled, b.length - data.length);
    b.copyWithin(0, this.filled - keep, this.filled);
    b.set(data, keep);
    this.filled = keep + data.length;
  }

  /** いまの音 { hz, note } 。しばらく測れなければ null（弾き終わった音をすぐには消さない） */
  read(now = performance.now()) {
    if (this.filled < this.buf.length) return null;
    const r = detectPitch(this.buf, this.sampleRate);
    if (r) {
      // 別の音に移ったら、前の音の測り値は捨てる
      if (this.recent.length && Math.abs(1200 * Math.log2(r.hz / this.recent[this.recent.length - 1])) > 50) this.recent = [];
      this.recent.push(r.hz);
      if (this.recent.length > 5) this.recent.shift();
      this.lastAt = now;
    } else if (now - this.lastAt > 1500) {
      this.recent = [];
    }
    if (this.recent.length === 0) return null;
    const hz = [...this.recent].sort((a, b) => a - b)[this.recent.length >> 1];
    return { hz, note: noteOf(hz) };
  }
}
