import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreFromAlphaTex, exportGp7, loadScore, buildChart } from '../src/chart.js';

const tex = `\\tempo 90 . \\track "G" \\staff {tabs} \\tuning e4 b3 g3 d3 a2 e2 \\capo 2
\\ro (0.6 2.4).4 3.2.4 0.1.8 0.1.8 2.1.4 | \\rc 2 \\tempo 120 0.5.2 (0.6 0.1).2 | 0.6.2 -.6.2`;

test('Guitar Pro に書き出して読み直しても同じ譜面になる', () => {
  const a = buildChart(scoreFromAlphaTex(tex), 0);
  const b = buildChart(loadScore(exportGp7(scoreFromAlphaTex(tex))), 0);
  assert.deepEqual(b.notes.map(n => [n.t, n.string, n.fret, n.midi]), a.notes.map(n => [n.t, n.string, n.fret, n.midi]));
});

test('繰り返し・テンポ変化・タイ・カポを反映する', () => {
  const c = buildChart(scoreFromAlphaTex(tex), 0);
  assert.deepEqual(c.bars.map(b => b.number), [1, 2, 1, 2, 3]);
  assert.ok(Math.abs(c.bars[1].t - 4 * (60 / 90)) < 1e-9);
  assert.ok(Math.abs(c.bars[2].t - (4 * (60 / 90) + 4 * (60 / 120))) < 1e-9);
  const first = c.notes.filter(n => n.t === 0);
  assert.deepEqual(first.map(n => [n.string, n.fret, n.midi]).sort(), [[4, 2, 54], [6, 0, 42]].sort());
  assert.equal(c.notes.filter(n => n.bar === 4).length, 1); // タイの先は数えない
});

test('別のボイスで刻んでいても、のばしている音は1度だけ入る', () => {
  const eighths = f => Array(8).fill(`${f}.1.8`).join(' ');
  const c = buildChart(scoreFromAlphaTex(`\\tempo 120 . \\track "G" \\staff {tabs} \\voice 0.6.1 | 3.6.1 \\voice ${eighths(0)} | ${eighths(1)}`), 0);
  assert.deepEqual(c.notes.filter(n => n.string === 6).map(n => [n.t, n.fret]), [[0, 0], [2, 3]]);
  assert.equal(c.notes.length, 18);
  assert.ok(c.notes.every((n, i) => i === 0 || c.notes[i - 1].t <= n.t), '時刻の順に並ぶ');
});
