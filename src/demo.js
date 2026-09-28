// 練習モードの「再生」。譜面の音を、弦を弾いた音（Karplus-Strong）で鳴らす。
// 鳴らしている間は弾いた音を聞き取らない（ヘッドホンで聞く前提。一緒に弾く使い方はしない）。
import { midiToHz } from './dsp.js';

const LOOKAHEAD = 0.25; // 何秒先の音まで予約しておくか（画面が止まっても音が途切れないように）
const LEAD = 0.1; // 押してから最初の音までの間

export class DemoPlayer {
  constructor(audio) {
    this.audio = audio;
    this.cache = new Map(); // `${kind}:${midi}` → { buffer, rate }
    this.out = null; // 鳴らしている間だけある
    this.voices = new Map(); // 弦 → 最後に予約した音 { src, gain }
  }

  get playing() { return this.out !== null; }

  /** 曲の from 秒から、曲の終わりまで鳴らす */
  start(chart, from) {
    this.stop();
    const a = this.audio;
    this.chart = chart;
    this.out = a.createGain();
    this.out.gain.value = 0.5;
    this.out.connect(a.destination);
    this.ctx0 = a.currentTime + LEAD;
    this.song0 = from;
    this.next = chart.notes.findIndex(n => n.t >= from - 1e-6);
    if (this.next < 0) this.next = chart.notes.length;
  }

  /** いま鳴っている曲の時刻（秒） */
  get pos() { return this.song0 + (this.audio.currentTime - this.ctx0); }

  /** 最後の音を鳴らして、響きも消えたか */
  get done() { return this.pos > this.chart.duration + 1.5; }

  /** 毎フレーム呼ぶ: 少し先までの音を予約する */
  pump() {
    if (!this.out) return;
    const notes = this.chart.notes, horizon = this.pos + LOOKAHEAD;
    while (this.next < notes.length && notes[this.next].t < horizon) this._play(notes[this.next++]);
  }

  stop() {
    if (!this.out) return;
    const now = this.audio.currentTime, out = this.out;
    out.gain.setTargetAtTime(0, now, 0.02);
    for (const v of this.voices.values()) v.src.stop(now + 0.15);
    setTimeout(() => out.disconnect(), 300);
    this.voices.clear();
    this.out = null;
  }

  _play(n) {
    const a = this.audio;
    const at = Math.max(a.currentTime, this.ctx0 + n.t - this.song0);
    // 同じ弦で次の音を弾いたら、前の音は止まる。それまでは鳴らしっぱなし（ギターの響きのまま）
    const prev = this.voices.get(n.string);
    if (prev) { prev.gain.gain.setTargetAtTime(0, at, 0.012); prev.src.stop(at + 0.1); }
    const { buffer, rate } = this._sound(n);
    const src = a.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const gain = a.createGain();
    gain.gain.value = n.kind === 'legato' ? 0.45 : n.string >= 4 ? 0.8 : 0.65; // 左手だけで鳴らす音は小さく、低音弦は少し太く
    src.connect(gain).connect(this.out);
    src.start(at);
    if (n.staccato) {
      // スタッカートは譜面の長さ（書かれた長さの半分）で止める。止めた音は次の音で止め直さない
      gain.gain.setTargetAtTime(0, at + n.dur, 0.012);
      src.stop(at + n.dur + 0.1);
      this.voices.delete(n.string);
    } else this.voices.set(n.string, { src, gain });
  }

  _sound(n) {
    const kind = n.kind === 'dead' || n.kind === 'harmonic' ? n.kind : 'normal';
    const key = `${kind}:${n.midi}`;
    if (!this.cache.has(key)) {
      const sr = this.audio.sampleRate, hz = midiToHz(n.midi);
      const { data, rate } = kind === 'harmonic' ? bell(sr, hz) : pluck(sr, hz, kind === 'dead' ? 0.02 : null);
      const buffer = this.audio.createBuffer(1, data.length, sr);
      buffer.copyToChannel(data, 0);
      this.cache.set(key, { buffer, rate });
    }
    return this.cache.get(key);
  }
}

/**
 * 弦を弾いた音（Karplus-Strong）。tau は音が 1/e になるまでの秒（null なら音の高さで決める）。
 * 遅延の長さは整数なので、少し低めに作って playbackRate で正しい高さに戻す（高い音でも音程がずれない）
 */
function pluck(sr, hz, tau) {
  tau ??= Math.max(0.35, Math.min(1.4, 1.1 * Math.pow(110 / hz, 0.5))); // 低い音ほど長く響く
  const period = sr / hz;
  // 下のループは y[n] = (y[n-L] + y[n-L+1]) / 2 なので、1周は L - 0.5 サンプル
  const L = Math.max(2, Math.floor(period + 0.5));
  const rate = (L - 0.5) / period;
  const out = new Float32Array(Math.ceil(Math.min(4, tau * 5) * sr));
  let seed = Math.round(hz * 1000) >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const buf = new Float32Array(L);
  for (let k = 0; k < L; k++) buf[k] = rand();
  // 指で弾いたやわらかい音にするため、はじめの雑音の高い成分を削る
  for (let pass = 0; pass < 2; pass++) for (let k = 1; k < L; k++) buf[k] = 0.5 * (buf[k] + buf[k - 1]);
  const mean = buf.reduce((s, v) => s + v, 0) / L;
  for (let k = 0; k < L; k++) buf[k] -= mean;
  const decay = Math.exp(-(L - 0.5) / (tau * sr)); // 1周ごとの減り方
  let idx = 0, peak = 1e-9;
  for (let s = 0; s < out.length; s++) {
    const v = buf[idx];
    buf[idx] = decay * 0.5 * (v + buf[(idx + 1) % L]);
    idx = (idx + 1) % L;
    out[s] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  const fade = Math.min(out.length, Math.round(0.05 * sr));
  for (let s = 0; s < out.length; s++) out[s] *= (s >= out.length - fade ? (out.length - s) / fade : 1) / peak;
  return { data: out, rate };
}

/** ハーモニクス: 倍音の少ない、鐘のような澄んだ音 */
function bell(sr, hz) {
  const out = new Float32Array(Math.round(2.5 * sr));
  for (let s = 0; s < out.length; s++) {
    const t = s / sr;
    const env = Math.min(1, t / 0.003) * Math.exp(-t / 0.7);
    out[s] = env * (0.8 * Math.sin(2 * Math.PI * hz * t) + 0.15 * Math.sin(4 * Math.PI * hz * t) * Math.exp(-t / 0.2));
  }
  const fade = Math.round(0.05 * sr);
  for (let s = out.length - fade; s < out.length; s++) out[s] *= (out.length - s) / fade;
  return { data: out, rate: 1 };
}
