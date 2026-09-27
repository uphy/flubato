// 音ゲーモードの「テンポを合わせる」: テンポを揺らして弾いたとき、曲の時計が人についてきて音がとれるか。
// アプリと同じく、描画の刻み（60分の1秒）ごとに時計を進め、解析のフレームはその対応から曲の時刻に直して判定する。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadScore, buildChart } from '../src/chart.js';
import { Spectrum, WINDOW, HOP } from '../src/dsp.js';
import { Judge } from '../src/judge.js';
import { FlexClock } from '../src/flex.js';
import { ctxToSong } from '../src/clock.js';
import { render, SR } from './synth.mjs';
import { perform } from './perform.mjs';

const romance = buildChart(loadScore(new Uint8Array(fs.readFileSync(new URL('../songs/romance.gp', import.meta.url)))), 0);
const LEAD = 1; // 曲の 0 秒を弾く実時間

function play(chart, perf, follow) {
  const audio = render(perf.plays, perf.duration);
  const judge = new Judge(chart);
  judge.reset(0);
  const clock = follow ? new FlexClock(chart, judge, 0) : null;
  const m = { ctx0: 0, song0: -LEAD, speed: 1, points: [[0, -LEAD]] };
  let now = 0, song = -LEAD;
  const spec = new Spectrum(SR);
  for (let end = WINDOW; end <= audio.length; end += HOP) {
    const { flux } = spec.analyze(audio.subarray(end - WINDOW, end));
    const t = (end - WINDOW / 2) / SR;
    // 解析が届くのは窓の終わりのあと。それまでの刻みで時計を進める
    while (now + 1 / 60 <= end / SR) {
      const dt = 1 / 60;
      song += dt * (clock ? clock.rate(song) : 1) + (clock ? clock.takePhase(dt) : 0);
      now += dt;
      m.points.push([now, song]);
    }
    judge.step(ctxToSong(m, t), spec, flux);
    clock?.step(t, x => ctxToSong(m, x), spec, flux, 1);
  }
  const st = judge.state.filter(s => s.result === 'hit' || s.result === 'miss');
  return { rate: st.filter(s => s.result === 'hit').length / chart.notes.length, k: clock?.k };
}

test('テンポを揺らして弾いても（溜める・走る）、テンポを合わせればとれる', () => {
  const perf = perform(romance, { lead: LEAD, tempo: g => 1 + 0.3 * Math.sin(g / 7) });
  const fixed = play(romance, perf, false), flex = play(romance, perf, true);
  assert.ok(flex.rate >= 0.9, `合わせる ${flex.rate}`);
  assert.ok(flex.rate > fixed.rate + 0.08, `合わせる ${flex.rate} / 合わせない ${fixed.rate}`);
});

test('全体にゆっくり弾いたら、テンポの倍率がそれに寄る', () => {
  const perf = perform(romance, { lead: LEAD, tempo: () => 1.25 });
  const r = play(romance, perf, true);
  assert.ok(r.rate >= 0.9, `rate ${r.rate}`);
  assert.ok(Math.abs(r.k - 0.8) < 0.08, `k ${r.k}`);
});

test('途中で溜めても（1秒止まる）、待ってからついてくる', () => {
  const perf = perform(romance, { lead: LEAD, pause: { 30: 1 } });
  const r = play(romance, perf, true);
  assert.ok(r.rate >= 0.9, `rate ${r.rate}`);
});

test('譜面どおりに弾けば、合わせても合わせなくても同じくらいとれる', () => {
  const perf = perform(romance, { lead: LEAD });
  const fixed = play(romance, perf, false), flex = play(romance, perf, true);
  assert.ok(flex.rate >= fixed.rate - 0.03, `合わせる ${flex.rate} / 合わせない ${fixed.rate}`);
});
