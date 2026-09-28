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

test('装飾音は本音符と別の音として入り、印が付く。リズムの段には出さない', () => {
  const c = buildChart(scoreFromAlphaTex(`\\tempo 60 . 0.3.4 2.3.4 {gr} 3.3.4 {gr} 5.3.4 7.3.4 0.3.4 | 0.1.1`), 0);
  const bar0 = c.notes.filter(n => n.bar === 0);
  assert.deepEqual(bar0.map(n => [n.fret, n.grace && n.grace.slot]), [[0, null], [2, 1], [3, 0], [5, null], [7, null], [0, null]],
    '本音符に近い装飾音ほど slot が小さい');
  const main = bar0[3];
  assert.equal(main.t, 1, '本音符は拍の頭に残る');
  assert.ok(bar0[1].t < bar0[2].t && bar0[2].t < main.t);
  assert.equal(c.rhythm.filter(r => r.bar === 0).length, 4);
});

test('スタッカートは印が付き、長さが半分になる', () => {
  const c = buildChart(scoreFromAlphaTex(`\\tempo 60 . 3.3{st}.4 3.3.4 (0.1{st} 0.2{st}).2`), 0);
  assert.deepEqual(c.notes.map(n => [n.staccato, n.dur]), [[true, 0.5], [false, 1], [true, 1], [true, 1]]);
});

test('音の入ったボイスが2つある小節だけ、リズムを上下の符尾に分ける', () => {
  const eighths = Array(8).fill('0.1.8').join(' ');
  // 1小節目: 1弦を8分で刻み、6弦・5弦を2分でのばす。2小節目: ボイス2は休符だけ
  const c = buildChart(scoreFromAlphaTex(`\\tempo 120 . \\track "G" \\staff {tabs} \\voice ${eighths} | 0.1.1 \\voice 0.6.2 (2.5 2.4).2 | r.1`), 0);
  assert.deepEqual(c.bars.map(b => b.voiced), [true, false]);
  assert.equal(c.voiced, true);
  const bar0 = c.rhythm.filter(r => r.bar === 0);
  assert.deepEqual(bar0.filter(r => r.up).map(r => [r.duration, r.strings]), Array(8).fill([8, [1]]));
  assert.deepEqual(bar0.filter(r => !r.up).map(r => [r.duration, r.strings.sort()]), [[2, [6]], [2, [4, 5]]]);
  assert.deepEqual(c.rhythm.filter(r => r.bar === 1).map(r => [r.up, r.duration, r.rest]), [[false, 1, false]], '休符だけのボイスは描かない');
});

test('レットリングとアクセントは印が付く', () => {
  const c = buildChart(scoreFromAlphaTex(`\\tempo 60 . 3.3{lr}.4 3.3{ac}.4 3.3{hac}.4 3.3.4`), 0);
  assert.deepEqual(c.notes.map(n => [n.letRing, n.accent]), [[true, 0], [false, 1], [false, 2], [false, 0]]);
});

test('タイでつないだ音は、つないだ先までの長さになる', () => {
  const c = buildChart(scoreFromAlphaTex(`\\tempo 60 . 5.2.2 -.2.4 3.3.4 | -.3.1`), 0);
  assert.deepEqual(c.notes.map(n => [n.t, n.dur]), [[0, 3], [3, 5]]);
});

test('ストロークは和音に向きが付き、音を弦の順にずらして鳴らす', () => {
  const c = buildChart(scoreFromAlphaTex(`\\tempo 60 . (0.1 0.2 0.3).4{bd 480} (0.1 0.2 0.3).4{au} (0.1 0.2).4`), 0);
  assert.deepEqual(c.groups.map(g => g.stroke), [{ up: false, arpeggio: false }, { up: true, arpeggio: true }, null]);
  // ダウンは低い弦（3弦）から、アップは高い弦（1弦）から
  const strum = g => c.groups[g].noteIds.map(id => [c.notes[id].string, +c.notes[id].strum.toFixed(3)]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(strum(0), [[1, 0.5], [2, 0.25], [3, 0]]);
  assert.deepEqual(strum(1)[0], [1, 0]);
  assert.ok(strum(1)[2][1] > 0);
  assert.deepEqual(strum(2), [[1, 0], [2, 0]]);
});

test('テヌート・ゴーストノート・ブリッジミュートは印が付く', () => {
  const c = buildChart(scoreFromAlphaTex(`\\tempo 60 . 3.3{ten}.4 3.3{g}.4 3.3{pm}.4 3.3.4`), 0);
  assert.deepEqual(c.notes.map(n => [n.tenuto, n.ghost, n.palmMute]), [[true, false, false], [false, true, false], [false, false, true], [false, false, false]]);
});

test('強弱記号は変わったところにだけ付き、クレッシェンドは次の記号へ向けて強さを変える', () => {
  const c = buildChart(scoreFromAlphaTex(`\\tempo 60 . 3.3.4 3.3.4{dy p} 3.3.4{cre} 3.3.4{cre} | 3.3.4{dy f} 3.3.4 3.3.4{dec} 3.3.4{dec} | 3.3.4`), 0);
  assert.deepEqual(c.groups.map(g => g.dynamic), [null, 'p', null, null, 'f', null, null, null, null], '頭の f（何も書いていない）は出さない');
  assert.deepEqual(c.groups.map(g => g.hairpin), [null, null, '<', '<', null, null, '>', '>', null]);
  // p（-3）から f（0）へ: クレッシェンドの2つの和音で -3 → -1.5、f で届く。
  // デクレッシェンドの先に記号がないときは1段階（-1）下げ、そのまま保つ
  assert.deepEqual(c.notes.map(n => n.level), [0, -3, -3, -1.5, 0, 0, -0.5, -1, -1]);
});
