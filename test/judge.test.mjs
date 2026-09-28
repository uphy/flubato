import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadScore, scoreFromAlphaTex, buildChart } from '../src/chart.js';
import { render, runJudge } from './synth.mjs';

const romance = buildChart(loadScore(new Uint8Array(fs.readFileSync(new URL('../songs/romance.gp', import.meta.url)))), 0);
const jit = i => (((i * 7919) % 81) - 40) / 1000; // ±40ms のばらつき
const PRE = 1;
const play = (chart, f = n => n) => chart.notes.map(n => f({ t: n.t + PRE + jit(n.group), midi: n.midi, string: n.string, amp: n.string >= 5 ? 0.4 : 0.25 }));
const judge = (chart, plays) => runJudge(chart, render(plays, chart.duration + PRE + 0.5), { pre: PRE });

// 開放弦が鳴りっぱなしで重なり続ける、判定がいちばん難しい部類の曲
test('ロマンス: 譜面どおり弾けば、ほぼ全部とれる', () => {
  assert.ok(judge(romance, play(romance)).rate >= 0.85);
});

test('ロマンス: 全部半音ずれて弾いたら、ほぼとれない', () => {
  assert.ok(judge(romance, play(romance, p => ({ ...p, midi: p.midi + 1 }))).rate <= 0.1);
});

test('ロマンス: ベースを弾かなければ、ベースはとれない（1弦・2弦の倍音と取り違えない）', () => {
  const r = judge(romance, play(romance).filter(p => p.string !== 6));
  const bassHits = romance.notes.filter(n => n.string === 6 && r.judge.state[n.id].result === 'hit').length;
  assert.ok(bassHits <= 1, `bass hits ${bassHits}`);
});

test('無音なら何もとれない', () => {
  assert.equal(runJudge(romance, render([], romance.duration + 1, { noiseDb: -40 }), { pre: PRE }).hits, 0);
});

const scale = buildChart(scoreFromAlphaTex(`\\tempo 80 . \\track "G" \\staff {tabs} \\tuning e4 b3 g3 d3 a2 e2
3.6.4 0.5.4 2.5.4 3.5.4 | 0.4.4 2.4.4 3.4.4 0.3.4 | 2.3.4 0.2.4 1.2.4 3.2.4 | 0.1.4 1.1.4 3.1.4 5.1.4 | (0.6 2.5 2.4 1.3 0.2 0.1).1`), 0);

test('スケール: 譜面どおりならとれて、ずれの測り方もおおむね正しい', () => {
  const r = judge(scale, play(scale));
  assert.ok(r.rate >= 0.95, `rate ${r.rate}`);
  const errs = scale.notes.filter(n => r.judge.state[n.id].result === 'hit').map(n => r.judge.state[n.id].delta - jit(n.group));
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  assert.ok(Math.abs(mean) < 0.03, `bias ${mean}`);
});

test('スケール: 0.4秒遅れたら窓の外なのでとれない', () => {
  assert.ok(judge(scale, play(scale, p => ({ ...p, t: p.t + 0.4 }))).rate <= 0.1);
});

test('待ち受けモード: 遅れても窓を閉じずに待つ', () => {
  const r = runJudge(scale, render(play(scale, p => ({ ...p, t: p.t + 0.4 })), scale.duration + 2), { pre: PRE, waitMode: true });
  assert.ok(r.rate >= 0.9, `rate ${r.rate}`);
});

test('装飾音は弾かなくても失敗にならない', () => {
  const c = buildChart(scoreFromAlphaTex(`\\tempo 90 . 0.3.4 2.3.4 {gr} 3.3.4 5.3.4 7.3.4 | 0.1.1`), 0);
  const r = judge(c, play(c).filter((p, i) => !c.notes[i].grace));
  const grace = c.notes.find(n => n.grace);
  assert.equal(r.judge.state[grace.id].result, 'pass');
  assert.ok(c.notes.filter(n => !n.grace).every(n => r.judge.state[n.id].result === 'hit'));
});
