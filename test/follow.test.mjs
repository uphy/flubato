// 練習モードの追従。人っぽい演奏（テンポの揺れ・止まる・飛ばす・間違える・弾き直す）についていけるか
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadScore, scoreFromAlphaTex, buildChart } from '../src/chart.js';
import { perform, follow } from './perform.mjs';

const romance = buildChart(loadScore(new Uint8Array(fs.readFileSync(new URL('../songs/romance.gp', import.meta.url)))), 0);
const scale = buildChart(scoreFromAlphaTex(`\\tempo 80 . \\track "G" \\staff {tabs} \\tuning e4 b3 g3 d3 a2 e2
3.6.4 0.5.4 2.5.4 3.5.4 | 0.4.4 2.4.4 3.4.4 0.3.4 | 2.3.4 0.2.4 1.2.4 3.2.4 | 0.1.4 1.1.4 3.1.4 5.1.4 |
(0.6 2.5 2.4 1.3 0.2 0.1).2 (3.6 2.5 0.4 0.3 0.2 3.1).2 | (x.6 0.5 2.4 2.3 2.2 0.1).2 (0.6 2.5 2.4 1.3 0.2 0.1).2`), 0);

const run = (chart, script) => follow(chart, perform(chart, script));
const last = c => c.groups.length - 1;

const everyday = {
  'そのまま': {},
  'ゆっくり（0.6倍）': { tempo: () => 1.6 },
  '速め（1.3倍）': { tempo: () => 0.77 },
  'テンポが揺れる': { tempo: g => 0.8 + 0.6 * Math.sin(g / 5) ** 2 },
  '途中で止まって考える': { pause: { 5: 2.5, 12: 1.5 } },
  '和音をひとつ飛ばす': { skip: new Set([8]) },
  '違う音を弾く': { wrong: new Set([6]) },
};

for (const [name, script] of Object.entries(everyday)) {
  test(`スケール: ${name}`, () => {
    const r = run(scale, script);
    // 低い音域では半音が解析の刻みより狭く、1音遅れて次で追いつくことがある
    assert.ok(r.barRate >= 0.95 && r.rate >= 0.85, `bar ${r.barRate} rate ${r.rate}`);
    assert.equal(r.final, last(scale));
  });
}

// ロマンスは同じアルペジオをずっとくり返すので、音だけではどの拍か決まらない。いちばん難しい部類
for (const [name, script] of Object.entries({ ...everyday, '途中で止まって考える': { pause: { 5: 2.5, 12: 1.5, 30: 3 } }, '和音をひとつ飛ばす': { skip: new Set([8, 25]) }, '違う音を弾く': { wrong: new Set([6, 18, 40]) } })) {
  test(`ロマンス: ${name}（小節単位で合っている）`, () => {
    const r = run(romance, script);
    assert.ok(r.barRate >= 0.95, `bar ${r.barRate}`);
    assert.equal(r.final, last(romance));
  });
}

test('ロマンス: 小節の頭から弾き直しても、最後にはついてくる', () => {
  const r = run(romance, { back: { 20: 9 } });
  assert.ok(r.barRate >= 0.8, `bar ${r.barRate}`);
  assert.equal(r.final, last(romance));
});

// 実機の録音（指弾き）では、指が弦に触れた音と弦を離した音で、1音ごとにアタックが0.06〜0.09秒離れて2回立つ
test('指が弦に触れる音でアタックが二重に立っても、先走らない', () => {
  for (const [chart, script] of [[romance, {}], [romance, { tempo: g => 0.8 + 0.6 * Math.sin(g / 5) ** 2 }], [romance, { back: { 20: 9 } }], [scale, {}]]) {
    const r = follow(chart, perform(chart, script), { room: { touch: 0.08 } });
    assert.ok(r.barRate >= 0.95, `bar ${r.barRate}`);
    assert.equal(r.final, last(chart));
  }
});

test('止まった・弾き直した小節が、つっかえた小節として出る', () => {
  const r = run(scale, { pause: { 9: 3 }, back: { 11: 8 } });
  const bars = r.follower.stumbles().map(s => scale.groups.findIndex(g => g.bar === s.bar) >= 0 && s.bar);
  const barOfG = g => scale.groups[g].bar;
  assert.ok(bars.includes(barOfG(9)), `stumbles ${JSON.stringify(r.follower.stumbles())}`);
  assert.ok(r.follower.stumbles().some(s => s.back > 0 && s.bar === barOfG(8)));
});

test('ふつうに通して弾いたら、つっかえは（ほぼ）出ない', () => {
  for (const [chart, script] of [[romance, {}], [romance, { tempo: g => 0.8 + 0.6 * Math.sin(g / 5) ** 2 }], [scale, {}]]) {
    const st = run(chart, script).follower.stumbles();
    assert.ok(st.length <= 1, JSON.stringify(st));
  }
});

test('部屋の響きと雑音があっても（中くらいまで）ついてくる', () => {
  const room = { reverb: 0.3, noiseDb: -45 };
  for (const [chart, script, min] of [[scale, {}, 0.95], [romance, {}, 0.95], [romance, { back: { 20: 9 } }, 0.9]]) {
    const r = follow(chart, perform(chart, script), { room });
    assert.ok(r.barRate >= min, `bar ${r.barRate}`);
    assert.equal(r.final, last(chart));
  }
});
