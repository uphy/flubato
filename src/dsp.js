// マイク音の解析。耳コピ（何が鳴っているか当てる）はしない。
// 譜面が「この音を弾くはず」と言っている音について、それが今鳴り始めたかだけを見る。

export const WINDOW = 4096; // 48kHz で約85ms
export const FFT_SIZE = 8192; // ゼロ詰めして周波数の刻みを細かくする
export const HOP = 512;

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

export const midiToHz = m => 440 * Math.pow(2, (m - 69) / 12);

export class Spectrum {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.re = new Float64Array(FFT_SIZE);
    this.im = new Float64Array(FFT_SIZE);
    this.mag = new Float32Array(FFT_SIZE / 2);
    this.prevLog = new Float32Array(FFT_SIZE / 2);
    this.log = new Float32Array(FFT_SIZE / 2);
    this.hann = new Float32Array(WINDOW);
    for (let i = 0; i < WINDOW; i++) this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1));
    this.fluxHi = Math.min(FFT_SIZE / 2, Math.round((5000 * FFT_SIZE) / sampleRate));
    this.fluxLo = Math.round((70 * FFT_SIZE) / sampleRate);
  }

  /** samples: 長さ WINDOW。返り値 { flux, rms } */
  analyze(samples) {
    const { re, im, mag, log, prevLog, hann } = this;
    let sq = 0;
    for (let i = 0; i < WINDOW; i++) { re[i] = samples[i] * hann[i]; im[i] = 0; sq += samples[i] * samples[i]; }
    re.fill(0, WINDOW); im.fill(0, WINDOW);
    fftInPlace(re, im);
    prevLog.set(log);
    let flux = 0;
    for (let k = 0; k < mag.length; k++) {
      const m = Math.hypot(re[k], im[k]);
      mag[k] = m;
      log[k] = Math.log10(m + 1e-9) * 20;
    }
    for (let k = this.fluxLo; k < this.fluxHi; k++) {
      const d = log[k] - prevLog[k];
      if (d > 0) flux += d;
    }
    return { flux: flux / (this.fluxHi - this.fluxLo), rms: Math.sqrt(sq / WINDOW) };
  }

  /** 今のフレームの控え。あとで withSnapshot で同じ計算ができる */
  snapshot() { return { mag: this.mag.slice(), log: this.log.slice() }; }

  withSnapshot(snap, fn) {
    const { mag, log } = this;
    this.mag = snap.mag; this.log = snap.log;
    try { return fn(); } finally { this.mag = mag; this.log = log; }
  }

  /** f 付近（±cents）で、本当に山の頂上になっている bin があるか。よその山の裾だと端が最大になる */
  isPeak(hz, cents) {
    const r = Math.pow(2, cents / 1200);
    const lo = Math.max(1, Math.floor((hz / r) * FFT_SIZE / this.sr));
    const hi = Math.min(this.mag.length - 2, Math.ceil((hz * r) * FFT_SIZE / this.sr));
    let k = lo;
    for (let i = lo; i <= hi; i++) if (this.mag[i] > this.mag[k]) k = i;
    return this.mag[k] >= this.mag[k - 1] && this.mag[k] >= this.mag[k + 1];
  }

  /** f 付近（±cents）のいちばん大きい振幅 */
  peakAround(hz, cents) {
    const r = Math.pow(2, cents / 1200);
    const lo = Math.max(1, Math.floor((hz / r) * FFT_SIZE / this.sr));
    const hi = Math.min(this.mag.length - 1, Math.ceil((hz * r) * FFT_SIZE / this.sr));
    let best = 0;
    for (let k = lo; k <= hi; k++) if (this.mag[k] > best) best = this.mag[k];
    return best;
  }

  /**
   * その音らしさ（dB）。基音と倍音の山を重みつきで足す。
   * 低音弦は基音が弱くマイクでも拾いにくいので、倍音の寄与が大きい。
   */
  salience(midi) {
    const f0 = midiToHz(midi);
    let sum = 0;
    for (let h = 1; h <= 6; h++) {
      const f = f0 * h;
      if (f > 5000) break;
      sum += this.peakAround(f, 35) / Math.sqrt(h);
    }
    return Math.log10(sum + 1e-9) * 20;
  }

  /**
   * 基音か2倍音が「山」になっているか（dB）。山の高さ − まわり（±2〜4半音）でいちばん低いところ。
   * 谷を1か所に決めると、ほかの弦の倍音がちょうどそこに来て埋まることがある。
   * only に 1 か 2 を渡すと、基音だけ・2倍音だけを見る。
   * 上の倍音だけで判断すると、別の弦の音（例: 開放の2弦・1弦は6弦Eの3・4倍音）で揃ってしまう。
   */
  lowPeak(midi, only = 0) {
    const f0 = midiToHz(midi);
    const db = hz => Math.log10(this.peakAround(hz, 35) + 1e-9) * 20;
    let best = -Infinity;
    for (const h of only ? [only] : [1, 2]) {
      if (!this.isPeak(f0 * h, 35)) continue;
      const f = f0 * h;
      let valley = Infinity;
      for (const k of [-4, -3, -2, 2, 3, 4]) valley = Math.min(valley, db(f * Math.pow(2, k / 12)));
      const c = db(f) - valley;
      if (c > best) best = c;
    }
    return best;
  }

  /**
   * 基音の山の高さ（dB）。低い音（150Hz 未満）は基音が弱いので2倍音と大きいほう。
   * 山の頂上になっていない（半音となりの音の裾野にいるだけ）ときは 12dB 割り引く。
   * 低い音域では半音が解析の周波数の刻みより狭く、となりの音の裾野を拾いやすい
   */
  fundamental(midi) {
    const f0 = midiToHz(midi);
    let best = -Infinity;
    for (const h of f0 < 150 ? [1, 2] : [1]) {
      const v = Math.log10(this.peakAround(f0 * h, 35) + 1e-9) * 20 - (this.isPeak(f0 * h, 35) ? 0 : 12);
      if (v > best) best = v;
    }
    return best;
  }

  /** 奇数倍音（1・3・5倍）だけの山（dB）。この音の1オクターブ上には出ない成分 */
  oddSalience(midi) {
    const f0 = midiToHz(midi);
    let sum = 0;
    for (const h of [1, 3, 5]) sum += this.peakAround(f0 * h, 35) / Math.sqrt(h);
    return Math.log10(sum + 1e-9) * 20;
  }

  /** 雑音の床（dB）。帯域の中央値 */
  noiseFloor() {
    const arr = Array.from(this.log.subarray(this.fluxLo, this.fluxHi)).sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)];
  }
}

/**
 * アタック（全体の立ち上がり）の検出。直近の flux の中央値を基準にする。
 * 音が続く曲では平均や分散はアタック自身で膨らむので使わない。
 */
export class OnsetDetector {
  constructor({ refractory = 0.04, minFlux = 2.5, ratio = 2.5 } = {}) {
    this.minFlux = minFlux;
    this.ratio = ratio;
    this.refractory = refractory;
    this.hist = [];
    this.last = -Infinity;
  }

  reset() { this.hist = []; this.last = -Infinity; }

  /** t のフレームがアタックなら true */
  push(t, flux) {
    const h = this.hist;
    const sorted = [...h].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const prev = h.length ? h[h.length - 1] : 0;
    // 響く部屋ではアタックが鈍るので、固定の下限は低めにして中央値との比で見る
    const isOnset = h.length >= 8 && flux > this.minFlux && flux > median * this.ratio && flux > prev && t - this.last > this.refractory;
    h.push(flux);
    if (h.length > 40) h.shift();
    if (isOnset) this.last = t;
    return isOnset;
  }
}
