// 録音した演奏を追従器・判定器に通して、どう追えたかを出す。実機で調整するための道具。
//
//   node tools/eval.mjs <調査用.wav> [--verbose] [--opts '{"pLocal":0.02}']
//     アプリの「調査用に保存」の wav。曲・設定・アプリでの判断が埋め込まれているので、それだけで動かし直せる。
//     いまのコードで動かし直した結果と、弾いたときのアプリの判断との違いも出す（練習・音ゲーの両方）
//   node tools/eval.mjs <曲.gp|.gp5|.tex> <録音.wav> [--track N] [--from 小節番号] [--verbose]
//     曲と、ふつうの録音（アプリの「● 録音」など）を別々に渡す（練習モードとして動かす）
import fs from 'node:fs';
import { loadScore, scoreFromAlphaTex, buildChart, guitarTracks } from '../src/chart.js';
import { readWav } from './wav.mjs';
import { frames, replayPractice, replayGame, chartFromMeta } from './replay.mjs';
import { Follower } from '../src/follow.js';

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const verbose = args.includes('--verbose'); if (verbose) args.splice(args.indexOf('--verbose'), 1);
const trackArg = flag('--track', null);
const fromBar = Number(flag('--from', 1));
const opts = JSON.parse(flag('--opts', '{}'));
if (!args.length) {
  console.error('使い方: node tools/eval.mjs <調査用.wav> [--verbose] [--opts JSON]\n        node tools/eval.mjs <曲.gp> <録音.wav> [--track N] [--from 小節番号] [--verbose]');
  process.exit(1);
}

const wavFile = args.length === 1 ? args[0] : args[1];
const { samples, sampleRate, meta } = readWav(wavFile);
if (args.length === 1 && !meta) {
  console.error('この wav には調査用の情報が入っていません。曲のファイルも一緒に渡してください');
  process.exit(1);
}

let chart;
if (meta) {
  chart = chartFromMeta(meta);
  console.log(`調査用の録音: ${meta.createdAt}（アプリ ${meta.build}）${meta.kind === 'practice' ? '練習モード' : '音ゲーモード'}`);
  if (meta.note) console.log(`メモ: ${meta.note}`);
  console.log(`設定: マイクの遅れ ${Math.round(meta.settings.latency * 1000)}ms・判定 ${meta.settings.strict}・速さ ${meta.settings.speed}%・マイク「${meta.settings.device}」`);
} else {
  const songFile = args[0];
  const score = songFile.endsWith('.tex') ? scoreFromAlphaTex(fs.readFileSync(songFile, 'utf8')) : loadScore(new Uint8Array(fs.readFileSync(songFile)));
  chart = buildChart(score, trackArg !== null ? Number(trackArg) : guitarTracks(score)[0].index);
}
console.log(`曲: ${chart.title || '(無題)'}（${chart.trackName}）${chart.bars.length} 小節 / ${chart.groups.length} 和音`);
console.log(`録音: ${(samples.length / sampleRate).toFixed(1)} 秒 ${sampleRate}Hz`);
let peak = 0; // 解析の窓ごとの大きさ（RMS）の最大
for (let a = 0; a + 4096 <= samples.length; a += 512) {
  let sq = 0;
  for (let i = a; i < a + 4096; i++) sq += samples[i] * samples[i];
  peak = Math.max(peak, Math.sqrt(sq / 4096));
}
console.log(`音量のピーク: ${(20 * Math.log10(peak + 1e-9)).toFixed(1)} dBFS（-30 より小さいならマイクが遠い・小さい）`);

const bar = g => (g < 0 ? '-' : chart.bars[chart.groups[g].bar].number);
if (meta?.kind === 'game') game();
else practice();

function practice() {
  let f, moves;
  if (meta) ({ follower: f, moves } = replayPractice(meta, samples, sampleRate, { chart, opts }));
  else {
    f = new Follower(chart, opts);
    f.start(Math.max(0, chart.groups.findIndex(g => chart.bars[g.bar].number >= fromBar)));
    moves = [];
    for (const { t, spec, flux } of frames(samples, sampleRate)) { const ev = f.step(t, spec, flux); if (ev) moves.push(ev); }
  }
  const path = f.path();
  const agree = path.filter((p, i) => chart.groups[p.pos].bar === chart.groups[moves[i].pos].bar).length;
  console.log(`\n位置が動いた: ${moves.length} 回 / 譜面の和音: ${chart.groups.length}`);
  console.log(`最後にいた位置: ${bar(f.pos)}小節（その場の推定）→ ${bar(path.at(-1)?.pos ?? -1)}小節（見直し後）`);
  console.log(`その場の推定と見直し後が同じ小節だった割合: ${path.length ? Math.round((agree / path.length) * 100) : 0}%`);

  console.log('\n小節に入った時刻（見直し後。録音の頭からの秒）:');
  const t0 = meta?.takeStart ?? 0;
  let lastBar = null;
  const line = [];
  for (const p of path) {
    const b = chart.groups[p.pos].bar;
    if (b !== lastBar) { line.push(`${chart.bars[b].number}@${(p.t - t0).toFixed(1)}s`); lastBar = b; }
  }
  console.log('  ' + line.join('  '));

  const st = f.stumbles();
  console.log('\nつっかえ:');
  if (!st.length) console.log('  なし');
  for (const s of st) console.log(`  ${chart.bars[s.bar].number}小節  止まった ${s.hesitate}・弾き直し ${s.back}・飛ばした ${s.skip}`);

  if (meta) {
    // 弾いたときのアプリの判断と、いまのコードで動かし直した結果の違い
    const rec = meta.practice.moves;
    const same = rec.length === moves.length && rec.every((m, i) => Math.abs(m.t - moves[i].t) < 0.002 && m.pos === moves[i].pos);
    console.log(`\nアプリでの判断（${rec.length} 回）と動かし直した結果（${moves.length} 回）: ${same ? '同じ' : '違う'}`);
    if (!same) {
      let shown = 0;
      const n = Math.max(rec.length, moves.length);
      for (let i = 0; i < n && shown < 15; i++) {
        const a = rec[i], b = moves[i];
        if (a && b && Math.abs(a.t - b.t) < 0.002 && a.pos === b.pos) continue;
        console.log(`  ${i}: アプリ ${a ? `${(a.t - t0).toFixed(2)}s g${a.pos}（${bar(a.pos)}小節）` : '—'} / いま ${b ? `${(b.t - t0).toFixed(2)}s g${b.pos}（${bar(b.pos)}小節）` : '—'}`);
        shown++;
      }
    }
    const marks = meta.review ?? [];
    if (marks.length) {
      console.log('\nアプリの振り返りで出した印:');
      for (const r of marks) console.log(`  ${bar(r.g)}小節 g${r.g} ${r.t?.toFixed(2) ?? '—'}s  ${r.marks.map(m => m.split(':').slice(1).join(':')).join(' / ')}`);
    }
  }

  if (verbose) {
    console.log('\nアタックごと（録音の頭からの秒 / その場 → 見直し後 / 確からしさ / 候補の上位3つ [和音 尤度]）:');
    moves.forEach((m, i) => {
      const ev = f.events[i];
      const cand = ev ? [...ev.lik].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([q, l]) => `g${q}:${l.toFixed(2)}`).join(' ') : '';
      console.log(`  ${(m.t - t0).toFixed(2)}s  ${bar(m.pos)}小節 g${m.pos} → ${bar(path[i].pos)}小節 g${path[i].pos}  ${m.conf.toFixed(2)} ${m.kind}  ${cand}`);
    });
  }
}

function game() {
  const { judge } = replayGame(meta, samples, sampleRate, { chart, opts: Object.keys(opts).length ? { ...meta.game.judgeOpts, ...opts } : null });
  const rec = meta.game.notes;
  let hit = 0, total = 0, recHit = 0, diff = 0;
  const lines = [];
  chart.notes.forEach((n, i) => {
    const a = rec[i]?.[0], b = judge.state[i].result;
    if (b === 'hit' || b === 'miss') { total++; if (b === 'hit') hit++; }
    if (a === 'hit') recHit++;
    if (a !== b) { diff++; if (lines.length < 20) lines.push(`  ${bar(n.group)}小節 ${n.string}弦${n.fret}（g${n.group}）: アプリ ${a ?? '—'} / いま ${b ?? '—'}`); }
  });
  console.log(`\n当たった音: いま ${hit} / ${total}（アプリでは ${recHit}）`);
  console.log(`アプリでの判定と動かし直した結果: ${diff ? `${diff} 音違う` : '同じ'}`);
  lines.forEach(l => console.log(l));
  if (verbose) {
    console.log('\n音ごと（小節 弦フレット 結果 ずれms）:');
    chart.notes.forEach((n, i) => {
      const s = judge.state[i];
      if (s.result !== 'hit' && s.result !== 'miss') return;
      console.log(`  ${bar(n.group)}小節 ${n.string}弦${n.fret}  ${s.result}${s.result === 'hit' ? ` ${Math.round(s.delta * 1000)}ms` : ''}`);
    });
  }
}
