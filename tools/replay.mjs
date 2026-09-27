// 調査用に保存した wav（アプリの「調査用に保存」）を、アプリと同じ条件で動かし直す。
// meta は wav に埋め込まれた JSON（src/diag.js が作る）。
import { loadScore, scoreFromAlphaTex, buildChart } from '../src/chart.js';
import { Spectrum, WINDOW, HOP } from '../src/dsp.js';
import { Follower } from '../src/follow.js';
import { Judge } from '../src/judge.js';
import { ctxToSong } from '../src/clock.js';

/** 埋め込まれた曲のファイルから譜面を作る */
export function chartFromMeta(meta) {
  const bytes = Buffer.from(meta.song.bytes, 'base64');
  const score = meta.song.name.endsWith('.tex') ? scoreFromAlphaTex(bytes.toString('utf8')) : loadScore(new Uint8Array(bytes));
  return buildChart(score, meta.song.trackIndex ?? 0);
}

/**
 * アプリと同じ窓で解析したフレームを順に返す { t, spec, flux }。
 * t はアプリと同じ時計（AudioContext の秒）。meta がなければ録音の頭を 0 秒とする。
 * アプリの解析はマイクを開いたときからの HOP 刻みなので、窓の終わりをその刻みに合わせ、
 * アプリがその回の解析を始める前のフレーム（録音の頭の、前の流れの続き）は返さない
 */
export function* frames(samples, sampleRate, meta = null) {
  const spec = new Spectrum(sampleRate);
  const startFrame = meta?.takeStartFrame ?? 0;
  let end = WINDOW;
  if (meta?.micPhase != null) while ((startFrame + end) % HOP !== meta.micPhase) end++;
  for (; end <= samples.length; end += HOP) {
    const { flux } = spec.analyze(samples.subarray(end - WINDOW, end)); // 捨てるフレームも、次の flux のために解析はする
    const frameEnd = startFrame + end;
    if (meta?.afterFrame != null && frameEnd <= meta.afterFrame) continue;
    yield { t: (frameEnd - WINDOW / 2) / sampleRate, spec, flux };
  }
}

/** 練習モードを動かし直す。opts で追従器の設定を変えて試せる */
export function replayPractice(meta, samples, sampleRate, { chart = chartFromMeta(meta), opts = {} } = {}) {
  const f = new Follower(chart, opts);
  f.start(meta.practice.startGroup);
  const moves = [];
  for (const { t, spec, flux } of frames(samples, sampleRate, meta)) {
    const ev = f.step(t, spec, flux);
    if (ev) moves.push(ev);
  }
  return { chart, follower: f, moves };
}

/** 音ゲーモードを動かし直す。曲の時刻はアプリと同じく、始めたときの時刻から速さで進める（マイクの遅れぶん戻す）。テンポを合わせた回は、残した時計の対応で */
export function replayGame(meta, samples, sampleRate, { chart = chartFromMeta(meta), opts = null } = {}) {
  const gm = meta.game;
  const judge = new Judge(chart, opts ?? gm.judgeOpts);
  judge.reset(gm.range.from);
  chart.notes.forEach((n, i) => { if (n.t >= gm.range.to - 0.001) judge.state[i].result = 'skip'; });
  const m = gm.passMap;
  for (const { t, spec, flux } of frames(samples, sampleRate, meta)) {
    const song = ctxToSong(m, t - m.lat);
    judge.step(song, spec, flux);
  }
  return { chart, judge };
}
