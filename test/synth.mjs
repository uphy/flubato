// テスト用：譜面どおりにギターっぽい音（Karplus-Strong）を合成して、判定器に通す
import { Spectrum, WINDOW, HOP, midiToHz } from '../src/dsp.js';
import { Judge } from '../src/judge.js';

export const SR = 48000;
const TOUCH_AMP = Number(process.env.TOUCH_AMP ?? 0.04);

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

/**
 * plays: { t, midi, string, amp } の配列を合成。同じ弦で次が鳴ったら前の音は止まる。
 * touch: 指で弾くと、弦に指が触れた音（短い雑音）が弾く少し前に入る。その秒数（0 なら入れない）
 */
export function render(plays, duration, { seed = 1, noiseDb = -60, reverb = 0, touch = 0 } = {}) {
  const rand = rng(seed);
  const out = new Float32Array(Math.ceil((duration + 1) * SR));
  const sorted = [...plays].sort((a, b) => a.t - b.t);
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const next = sorted.slice(i + 1).find(q => q.string === p.string);
    const end = Math.min(out.length, Math.floor((next ? next.t + 0.01 : duration + 1) * SR));
    const start = Math.max(0, Math.floor(p.t * SR));
    const period = SR / midiToHz(p.midi);
    const L = Math.max(2, Math.round(period));
    const buf = new Float32Array(L);
    for (let k = 0; k < L; k++) buf[k] = rand() * 2 - 1;
    // ピックの位置っぽくローパスをかける
    for (let k = 1; k < L; k++) buf[k] = 0.5 * buf[k] + 0.5 * buf[k - 1];
    const decay = 0.9985;
    let idx = 0;
    for (let s = start; s < end; s++) {
      const a = buf[idx], b = buf[(idx + 1) % L];
      const v = decay * 0.5 * (a + b);
      buf[idx] = v;
      idx = (idx + 1) % L;
      // 止めるときは短くフェード
      const fade = s > end - 240 ? (end - s) / 240 : 1;
      out[s] += a * (p.amp ?? 0.3) * fade;
    }
  }
  if (touch > 0) {
    for (const t of new Set(sorted.map(p => p.t))) {
      const start = Math.max(0, Math.floor((t - touch) * SR));
      for (let s = start; s < Math.min(out.length, start + 0.015 * SR); s++) out[s] += (rand() * 2 - 1) * TOUCH_AMP * (1 - (s - start) / (0.015 * SR));
    }
  }
  if (reverb > 0) addReverb(out, reverb);
  const n = Math.pow(10, noiseDb / 20);
  for (let s = 0; s < out.length; s++) out[s] += (rand() * 2 - 1) * n;
  return out;
}

/** 音声を判定器に流す。latency 秒だけ遅れてマイクに入ったことにできる */
export function runJudge(chart, audio, { opts = {}, latency = 0, waitMode = false, pre = 0 } = {}) {
  const spec = new Spectrum(SR);
  const judge = new Judge(chart, opts);
  judge.waitMode = waitMode;
  const events = [];
  for (let end = WINDOW; end <= audio.length; end += HOP) {
    const { flux } = spec.analyze(audio.subarray(end - WINDOW, end));
    const center = (end - WINDOW / 2) / SR - latency - pre;
    events.push(...judge.step(center, spec, flux));
  }
  // 最後まで流して残りは miss
  const hits = judge.state.filter(s => s.result === 'hit').length;
  return { judge, events, hits, rate: hits / chart.notes.length };
}

/** 部屋の響きっぽいもの（Schroeder 型: 並列のコム4本 + 直列のオールパス2本）。wet は響きの量 0〜1 */
function addReverb(x, wet) {
  const combs = [1557, 1617, 1491, 1422].map(d => ({ buf: new Float32Array(Math.round(d * SR / 44100)), i: 0, g: 0.84 }));
  const aps = [225, 556].map(d => ({ buf: new Float32Array(Math.round(d * SR / 44100)), i: 0, g: 0.5 }));
  for (let s = 0; s < x.length; s++) {
    const dry = x[s];
    let y = 0;
    for (const c of combs) { const v = c.buf[c.i]; c.buf[c.i] = dry + v * c.g; c.i = (c.i + 1) % c.buf.length; y += v; }
    y /= combs.length;
    for (const a of aps) { const v = a.buf[a.i]; const u = y + v * a.g; a.buf[a.i] = u; a.i = (a.i + 1) % a.buf.length; y = v - u * a.g; }
    x[s] = dry + y * wet * 3;
  }
}
