// 振り返り: 弾き終わってから、どの和音がどう悪かったかが出るか
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadScore, buildChart } from '../src/chart.js';
import { Spectrum, WINDOW, HOP } from '../src/dsp.js';
import { Follower } from '../src/follow.js';
import { practiceReview, gameReview, groupAt, describe, issues, spots } from '../src/review.js';
import { perform } from './perform.mjs';
import { render, runJudge, SR } from './synth.mjs';

const romance = buildChart(loadScore(new Uint8Array(fs.readFileSync(new URL('../songs/romance.gp', import.meta.url)))), 0);
const kinds = (rv, g) => rv.groups[g].marks.map(m => m.kind);

function practice(script) {
  const perf = perform(romance, script);
  const audio = render(perf.plays, perf.duration);
  const spec = new Spectrum(SR);
  const f = new Follower(romance);
  for (let end = WINDOW; end <= audio.length; end += HOP) {
    const { flux } = spec.analyze(audio.subarray(end - WINDOW, end));
    f.step((end - WINDOW / 2) / SR, spec, flux);
  }
  return { perf, rv: practiceReview(romance, f, { samples: audio, sampleRate: SR, t0: 0 }) };
}

test('練習: ふつうに通して弾いたら、問題はほとんど出ない', () => {
  const { rv } = practice({});
  const bad = issues(rv).filter(g => rv.groups[g].marks.some(m => m.kind !== 'weak'));
  assert.ok(bad.length <= 3, bad.map(g => describe(romance, rv, g)).join('\n'));
});

test('練習: 止まった・戻った・飛ばした・急いだ・違う音が、その和音に出る', () => {
  const { rv, perf } = practice({
    pause: { 20: 2.5 }, back: { 40: 36 }, skip: new Set([12]), wrong: new Set([50]),
    tempo: g => (g === 29 ? 0.55 : 1), // 29 のあと詰めて弾く → 30 が急いだ（0.1秒を切ると同じアタックにまとまる）
  });
  assert.ok(kinds(rv, 20).includes('hesitate'), describe(romance, rv, 20));
  assert.ok(kinds(rv, 40).includes('back'), describe(romance, rv, 40));
  assert.ok(kinds(rv, 12).includes('skip'), describe(romance, rv, 12));
  assert.ok(kinds(rv, 30).includes('rush'), describe(romance, rv, 30));
  // 違う音を弾いた和音は、譜面の音が聞こえなかったことになる（前から鳴っていた音は「弱い」で残ることがある）
  assert.ok(kinds(rv, 50).some(k => k === 'missing' || k === 'weak'), describe(romance, rv, 50));
  // 苦手な箇所は小節ごとにまとまり、何が悪かったかが短く付く
  const sp = spots(romance, rv);
  const at = g => sp.find(x => x.bar === romance.groups[g].bar);
  assert.match(at(20)?.summary ?? '', /止まった/);
  assert.match(at(12)?.summary ?? '', /飛ばした/);
  // 再生位置から和音が引ける
  const s = perf.steps.find(x => x.g === 25);
  assert.equal(groupAt(rv, s.t + 0.05), 25);
});

test('音ゲー: 早い・遅い・鳴っていない音が和音ごとに出る', () => {
  const plays = [];
  romance.groups.forEach((grp, gi) => {
    if (gi === 10) return; // 弾かない
    const shift = gi === 20 ? 0.13 : gi === 30 ? -0.1 : 0;
    for (const id of grp.noteIds) {
      const n = romance.notes[id];
      plays.push({ t: n.t + 1 + shift, midi: n.midi, string: n.string, amp: n.string >= 5 ? 0.4 : 0.25 });
    }
  });
  const audio = render(plays, romance.duration + 3);
  const { judge } = runJudge(romance, audio, { pre: 1 });
  const rv = gameReview(romance, judge, t => t + 1, 1, romance.duration + 3);
  assert.ok(kinds(rv, 10).includes('missing'), describe(romance, rv, 10));
  assert.ok(kinds(rv, 20).includes('late'), describe(romance, rv, 20));
  assert.ok(kinds(rv, 30).includes('rush'), describe(romance, rv, 30));
  assert.deepEqual(kinds(rv, 5), [], describe(romance, rv, 5));
});

test('調査用の wav: 情報を埋め込んで読み戻せ、録音は32bit のまま', async () => {
  const { encodeWav } = await import('../src/recorder.js');
  const { readWav } = await import('../tools/wav.mjs');
  const os = await import('node:os');
  const path = await import('node:path');
  const x = new Float32Array([0, 0.123456789, -0.5, 0.25]);
  const meta = { format: 'flubato-diag', note: '3小節目で止まった' };
  const buf = encodeWav([x], x.length, 48000, { id: 'flrp', bytes: new TextEncoder().encode(JSON.stringify(meta)) }, true);
  const file = path.join(os.tmpdir(), `flubato-diag-test-${process.pid}.wav`);
  fs.writeFileSync(file, Buffer.from(buf));
  const r = readWav(file);
  fs.unlinkSync(file);
  assert.deepEqual(r.meta, meta);
  assert.deepEqual([...r.samples], [...x]);
});
