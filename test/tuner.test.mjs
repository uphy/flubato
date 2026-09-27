import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch, noteOf, Tuner } from '../src/tuner.js';

const SR = 48000;
const cents = (a, b) => 1200 * Math.log2(a / b);

/** 倍音つきの音。amps[k] が k+1 倍音の強さ */
function tone(hz, amps = [1, 0.6, 0.4, 0.3, 0.2, 0.1], n = 4096, noise = 0) {
  const x = new Float32Array(n);
  let s = 1;
  for (let i = 0; i < n; i++) {
    let v = 0;
    amps.forEach((a, k) => { v += a * Math.sin(2 * Math.PI * hz * (k + 1) * i / SR + k); });
    s = (s * 1664525 + 1013904223) >>> 0;
    x[i] = 0.1 * v + noise * (s / 2 ** 31 - 1);
  }
  return x;
}

test('ギターの開放弦の高さを 1 セント以内で測る', () => {
  for (const hz of [82.41, 110, 146.83, 196, 246.94, 329.63]) {
    const r = detectPitch(tone(hz), SR);
    assert.ok(r && Math.abs(cents(r.hz, hz)) < 1, `${hz}Hz → ${r?.hz}`);
  }
});

test('基音が弱い低音でも、2倍の高さと取り違えない', () => {
  const r = detectPitch(tone(82.41, [0.15, 1, 0.7, 0.5, 0.3]), SR);
  assert.ok(Math.abs(cents(r.hz, 82.41)) < 1, `→ ${r.hz}`);
});

test('少し雑音が乗っても測れて、雑音だけなら何も出さない', () => {
  const r = detectPitch(tone(110, undefined, 4096, 0.02), SR);
  assert.ok(Math.abs(cents(r.hz, 110)) < 3, `→ ${r.hz}`);
  assert.equal(detectPitch(tone(110, [], 4096, 0.2), SR), null);
  assert.equal(detectPitch(new Float32Array(4096), SR), null);
});

test('音名とずれ', () => {
  assert.deepEqual(noteOf(440), { midi: 69, name: 'A', octave: 4, cents: 0 });
  const e = noteOf(82.41 * 2 ** (10 / 1200));
  assert.equal(`${e.name}${e.octave}`, 'E2');
  assert.ok(Math.abs(e.cents - 10) < 0.5);
  const low = noteOf(466.16 * 2 ** (-40 / 1200)); // A#4 より 40 セント低い
  assert.equal(`${low.name}${low.octave}`, 'A#4');
  assert.ok(Math.abs(low.cents + 40) < 0.5);
});

test('Tuner: 小分けに流し込んでも測れて、音が消えてしばらくすると空になる', () => {
  const t = new Tuner(SR);
  const x = tone(196, undefined, 8192);
  for (let i = 0; i < x.length; i += 128) t.push(x.subarray(i, i + 128));
  const r = t.read(0);
  assert.equal(`${r.note.name}${r.note.octave}`, 'G3');
  t.push(new Float32Array(4096));
  assert.ok(t.read(1000), '弾き終わってすぐは前の音を出したまま');
  assert.equal(t.read(2000), null);
});
