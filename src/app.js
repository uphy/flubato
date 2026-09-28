import { loadScore, scoreFromAlphaTex, buildChart, guitarTracks } from './chart.js';
import { Judge, DEFAULTS } from './judge.js';
import { Mic } from './mic.js';
import { practiceDiag, gameDiag, diagWav, toBase64 } from './diag.js';
import { View, drawCountIn } from './view.js';
import { SheetView } from './sheet.js';
import { Follower } from './follow.js';
import { Recorder, Take } from './recorder.js';
import { practiceReview, gameReview, groupAt, describe, spots } from './review.js';
import { songToCtx } from './clock.js';
import { FlexClock } from './flex.js';
import { listSongs, getSong, saveSong, touchSong, removeSong, clearSongs } from './library.js';
import { DemoPlayer } from './demo.js';
import { Tuner } from './tuner.js';
import { BUILD, latestBuild, shouldReload, reloadTo, describeBuild } from './update.js';
import demoBytes from '../songs/romance.gp';

const $ = id => document.getElementById(id);
const STRICTNESS = {
  loose: { early: 0.2, late: 0.26, neighborDb: -2, riseDb: 6 },
  normal: {},
  strict: { early: 0.1, late: 0.12, neighborDb: 1.5, riseDb: 9 },
};
const store = {
  get(k, d) { try { const v = localStorage.getItem('flubato.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('flubato.' + k, JSON.stringify(v)); } catch { /* 保存できなくても動く */ } },
};

const S = {
  score: null, chart: null, trackIndex: 0, judge: null,
  audio: null, mic: null,
  mode: store.get('mode', 'practice'), // 'practice'（譜面がついてくる）| 'game'（音ゲー）
  gameView: store.get('gameView', 'lane'), // 音ゲーモードの見た目。'lane'（音符が流れてくる）| 'sheet'（練習モードと同じタブ譜の上を線が動く）
  playing: false, song: 0, lastNow: 0, history: [],
  follower: null, listening: false, practiceStart: 0, doneAt: null,
  demo: null, // 練習モードの「再生」（demo.js）
  demoResume: null, // 再生を停止ボタンで止めたところ（group）。次の「再生」はここから
  recorder: null,
  take: null, // 振り返り用に、いま弾いている回の音をためる
  lastReview: null, // 直前の回の振り返り { data, take, diag（調査用）, song, trackIndex, title }
  songFile: null, // いま開いている曲のファイル { name, bytes }（調査用に保存するときに埋め込む）
  songId: null, // ライブラリでの id（デモなら null）
  diagMoves: [], // 練習モードでその場で位置が動いたアタック（調査用）
  hub: null, // 振り返り（苦手な箇所の一覧と録音、再生の状態）
  reviewing: false, // 振り返りの画面を開いているか
  drill: null, // 振り返りから小節を練習しに来ているとき { bar }
  beforeDrill: null, // 小節を練習しに行く前の設定 { mode, from, to, loop, speed }（「最初から通す」で戻す）
  range: null, // { from, to } 秒
  latency: store.get('latency', 0.05),
  calibrating: null, // 合わせ中は元の譜面を退避
  passes: [],
  tuner: null, // チューナーを開いているあいだだけ Tuner
};
const view = new View($('stage'));
const sheet = new SheetView($('stage'));

// ---- 曲の読み込み ----
function setScore(score, label) {
  S.score = score;
  const tracks = guitarTracks(score);
  if (tracks.length === 0) { toast('ギターのトラックが見つかりませんでした'); return; }
  const sel = $('track');
  sel.innerHTML = tracks.map(t => `<option value="${t.index}">${escapeHtml(t.name)}</option>`).join('');
  sel.parentElement.hidden = tracks.length < 2;
  setTrack(tracks[0].index);
  $('title').textContent = label || [score.title, score.artist].filter(Boolean).join(' — ') || '無題';
  $('title').title = $('title').textContent;
}

function setTrack(index) {
  S.trackIndex = index;
  S.chart = buildChart(S.score, index);
  S.judge = new Judge(S.chart, strictOpts());
  const opts = S.chart.bars.map((b, i) => {
    const again = S.chart.bars.slice(0, i).filter(x => x.index === b.index).length;
    return `<option value="${i}">${b.number}${again ? `（${again + 1}回目）` : ''}</option>`;
  }).join('');
  $('from').innerHTML = opts;
  $('to').innerHTML = opts;
  $('from').value = '0';
  $('to').value = String(S.chart.bars.length - 1);
  stop();
  stopPractice(false);
  stopDemo();
  S.follower = new Follower(S.chart);
  S.song = -1;
  S.lastReview = null;
  S.hub = null; S.drill = null;
  updateBackButton();
  updateStats();
  $('song-meta').textContent = songMeta(S.chart);
}

/** 曲の下に出す1行: 小節数・テンポ・拍子・チューニング・カポ */
function songMeta(c) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const tuning = [...c.tuning].reverse().map(m => names[m % 12]).join(' ');
  const b = c.bars[0];
  return [`${new Set(c.bars.map(x => x.index)).size}小節`, `♩=${Math.round(c.tempo)}`, b && `${b.num}/${b.den}`,
    tuning === 'E A D G B E' ? 'レギュラー' : tuning, c.capo ? `カポ ${c.capo}` : null].filter(Boolean).join('  ·  ');
}

async function openFile(file) {
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    setScore(loadScore(bytes), null);
  } catch (e) {
    console.error(e);
    toast(`読めませんでした: ${file.name}（Guitar Pro 3〜8 / MusicXML に対応）`);
    return;
  }
  S.songFile = { name: file.name, bytes };
  if (!S.score.title) $('title').textContent = file.name.replace(/\.[^.]+$/, '');
  closeLibrary();
  // 読めた曲はライブラリに取っておく。保存できなくても、いま開くのはできている
  try {
    S.songId = await saveSong({ name: file.name, title: $('title').textContent, bytes });
    store.set('lastSong', S.songId);
  } catch (e) {
    console.error(e);
    S.songId = null;
    toast('曲をこのブラウザに保存できませんでした。次に開くときは、またファイルを選んでください');
  }
}

const DEMO_TITLE = 'Romance（デモ・練習用の簡易アレンジ）';
function openDemo() {
  setScore(loadScore(new Uint8Array(demoBytes)), DEMO_TITLE);
  S.songFile = { name: 'romance.gp', bytes: new Uint8Array(demoBytes) };
  S.songId = null;
  store.set('lastSong', null);
}

/** ライブラリに取っておいた曲を開く。前に選んでいたトラックも戻す */
async function openSaved(id) {
  const rec = await getSong(id);
  if (!rec) throw new Error(`ライブラリにない曲: ${id}`);
  setScore(loadScore(rec.bytes), rec.title);
  if (rec.trackIndex !== undefined && [...$('track').options].some(o => o.value === String(rec.trackIndex))) {
    setTrack(rec.trackIndex); $('track').value = String(rec.trackIndex);
  }
  S.songFile = { name: rec.name, bytes: rec.bytes };
  S.songId = id;
  store.set('lastSong', id);
  touchSong(id, { openedAt: Date.now() }).catch(() => {});
}

// ---- ライブラリ（保存した曲の一覧） ----
async function openLibrary() {
  closeSettings();
  $('library').hidden = false; $('scrim').hidden = false;
  await renderLibrary();
}
function closeLibrary() { $('library').hidden = true; $('scrim').hidden = $('settings').hidden; }
async function renderLibrary() {
  let songs = [];
  try { songs = await listSongs(); } catch (e) { console.error(e); }
  const day = t => new Date(t).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
  const item = (id, title, sub, del) => `<li data-id="${id}" aria-current="${(S.songId ?? 'demo') === id}">` +
    `<button class="open"><b>${escapeHtml(title)}</b><span>${escapeHtml(sub)}</span></button>` +
    (del ? `<button class="del icon-btn ghost" title="ライブラリから消す"><svg class="i"><use href="#i-x"/></svg></button>` : '') + '</li>';
  $('lib-list').innerHTML = songs.map(s => item(s.id, s.title, `${s.name} · ${day(s.openedAt)}に開いた`, true)).join('') +
    item('demo', DEMO_TITLE, '最初から入っている曲', false);
}

// ---- 設定 ----
function strictOpts() {
  return { ...DEFAULTS, ...STRICTNESS[$('strict').value] };
}
function speed() { return Number($('speed').value) / 100; }
function selectedRange() {
  const a = Number($('from').value), b = Math.max(a, Number($('to').value));
  return { from: S.chart.bars[a].t, to: S.chart.bars[b].end, a, b };
}

// ---- 音 ----
async function ensureAudio() {
  await ensureOutput();
  if (!S.mic) await startMic();
}

/** 音を出すだけ（マイクは使わない） */
async function ensureOutput() {
  if (!S.audio) S.audio = new AudioContext({ latencyHint: 'interactive' });
  // 音の出力先がうまく開けないと resume が返ってこないことがある。黙って止まらないように待つ時間を決める
  if (S.audio.state !== 'running') await Promise.race([S.audio.resume(), new Promise((_, ng) => setTimeout(() => ng(new Error('resume')), 4000))]);
}

async function startMic() {
  if (!window.isSecureContext) throw new Error('insecure');
  const mic = new Mic(S.audio);
  try {
    await mic.start($('device').value || undefined);
  } catch (e) {
    // 前に選んだマイクが見つからない（外した）ときは、既定のマイクでやり直す
    if (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError' || !$('device').value) throw e;
    $('device').value = '';
    store.set('device', '');
    await mic.start(undefined);
  }
  mic.onFrame = onFrame;
  mic.onSamples = (d, end) => {
    S.recorder?.push(d);
    S.tuner?.push(d);
    if (!S.take) return;
    S.take.push(d, end);
    // マイクを開いた直後に始めた回は、始めた時点で解析の刻みがまだわからない。最初の音が届いたときに埋める
    S.take.micPhase ??= mic.hopPhase;
  };
  mic.onEnded = () => {
    if (S.mic !== mic) return;
    S.mic = null;
    updateMicInfo();
    toast('マイクが使えなくなりました（外れたか、ほかのアプリに取られました）。設定でマイクを選び直してください');
  };
  S.mic = mic;
  S.quietSince = null; S.quietWarned = false;
  await refreshDevices();
  updateMicInfo();
}

/** マイクを使えなかった理由を、どうすればいいかと一緒に出す */
function micError(e) {
  console.error(e);
  const msg = {
    insecure: 'マイクは https か localhost で開いたときだけ使えます',
    resume: '音を始められませんでした。Mac の音の出力先（スピーカー・ヘッドホン）を確認して、もう一度押してください',
    NotAllowedError: /system/i.test(e.message)
      ? 'Mac の設定で、Chrome がマイクを使えないようになっています。「システム設定 → プライバシーとセキュリティ → マイク」で Chrome をオンにして、Chrome を開き直してください'
      : 'マイクの使用が許可されていません。アドレスバーの左のアイコンから、マイクを「許可」にしてください',
    NotFoundError: 'マイクが見つかりませんでした。Mac の「システム設定 → サウンド → 入力」にマイクがあるか確認してください',
    NotReadableError: 'マイクを開けませんでした。ほかのアプリ（会議アプリなど）が使っていないか確認してください',
  }[e.message === 'insecure' || e.message === 'resume' ? e.message : e.name];
  toast(msg ?? `マイクを使えませんでした（${e.name}: ${e.message}）`);
}

async function refreshDevices() {
  try {
    const list = await Mic.devices();
    const cur = $('device').value || store.get('device', '');
    // 許可をもらう前は名前が取れない（空の項目しか来ない）
    const named = list.filter(d => d.label && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const def = list.find(d => d.deviceId === 'default' && d.label);
    $('device').innerHTML = `<option value="">${escapeHtml(def ? def.label.replace(/^(既定|Default)\s*-\s*/, '既定: ') : '既定のマイク（Mac の設定で選んでいるもの）')}</option>` +
      named.map(d => `<option value="${d.deviceId}">${escapeHtml(d.label)}</option>`).join('');
    $('device').value = named.some(d => d.deviceId === cur) ? cur : '';
  } catch { /* 一覧が取れなくても既定のマイクで動く */ }
}

/** 設定パネルとマイクのボタンに、いま使っているマイクを出す */
function updateMicInfo() {
  $('mic-start').hidden = !!S.mic;
  $('mic-state').textContent = S.mic
    ? `使用中: ${S.mic.label || '既定のマイク'}。弾くたびに上の音量のバーが動けば、拾えています。`
    : 'マイクはまだ使っていません。「マイクを使う」か「はじめる」を押すと、ブラウザがマイクの許可を聞いてきます。';
  $('mic-btn').title = S.mic ? `マイク: ${S.mic.label || '既定のマイク'}` : 'マイクを使う';
}

function click(atCtx, accent) {
  const a = S.audio, o = a.createOscillator(), g = a.createGain();
  o.frequency.value = accent ? 2000 : 1500;
  g.gain.setValueAtTime(0.0001, atCtx);
  g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, atCtx + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, atCtx + 0.05);
  o.connect(g).connect(a.destination);
  o.start(atCtx); o.stop(atCtx + 0.06);
}

// ---- 進行 ----
async function start() {
  try {
    await ensureAudio();
  } catch (e) {
    micError(e);
    return;
  }
  S.range = selectedRange();
  if (S.drill && (S.range.a !== S.drill.bar || S.range.b !== S.drill.bar)) S.drill = null;
  S.passes = [];
  begin();
  $('result').hidden = true;
}

function begin() {
  const { from, to } = S.range;
  S.judge = new Judge(S.chart, S.calibrating ? { ...DEFAULTS, early: 0.35, late: 0.35 } : strictOpts());
  S.judge.reset(from);
  S.chart.notes.forEach((n, i) => { if (n.t >= to - 0.001) S.judge.state[i].result = 'skip'; });
  // 1小節ぶん（その小節の拍子の数だけ）カウントしてから
  const c = countIn(from), beat = c.beat / speed();
  const now = S.audio.currentTime;
  for (let k = 0; k < c.n; k++) click(now + 0.1 + k * beat, k === 0);
  S.song = from - (0.1 + c.n * beat) * speed();
  S.lastNow = now;
  // 振り返り用: この回の音と、曲の時刻 → AudioContext の時刻の対応（マイクの遅れぶんあとに聞こえる）
  S.take = newTake();
  S.passMap = { ctx0: now, song0: S.song, speed: speed(), lat: S.calibrating ? 0 : S.latency };
  // テンポを合わせるときは曲の時計の進み方が変わるので、刻みごとの対応を残す（振り返り・調査用）
  if (following()) S.passMap.points = [[now, S.song]];
  S.flex = new FlexClock(S.chart, S.judge, from);
  S.history = [];
  S.playing = true;
  S.nextClick = S.chart.beats.findIndex(b => b.t >= from - 1e-6);
  setPlayLabel();
  updateStats();
}

/** はじめる前のカウント: 始める小節の拍子の分子の数だけ、分母の音符の長さで（3/4 なら4分で3つ、6/8 なら8分で6つ） */
function countIn(from) {
  const bar = S.chart.bars.find(b => b.end > from + 1e-6) ?? S.chart.bars[0];
  return { n: bar.num, beat: S.chart.beatSec(from) * (4 / bar.den) };
}

function stop() {
  S.playing = false;
  S.take = null;
  setPlayLabel();
}

function tick() {
  requestAnimationFrame(tick);
  if (!S.chart) return;
  if (S.playing) {
    const now = S.audio.currentTime, dt = now - S.lastNow;
    const rate = speed() * (following() ? S.flex.rate(S.song) : 1);
    let next = S.song + dt * rate;
    if (following()) next += S.flex.takePhase(dt);
    S.lastNow = now;
    // メトロノーム
    if ($('metro').checked) {
      const beats = S.chart.beats;
      while (S.nextClick >= 0 && S.nextClick < beats.length && beats[S.nextClick].t < next + 0.1 && beats[S.nextClick].t < S.range.to - 1e-6) {
        const b = beats[S.nextClick];
        const at = now + (b.t - next) / rate;
        if (at >= now - 0.01) click(Math.max(now, at), b.first);
        S.nextClick++;
      }
    }
    S.song = next;
    S.history.push([now, next]);
    if (S.history.length > 240) S.history.shift();
    S.passMap.points?.push([now, next]);
    if (S.song > S.range.to + DEFAULTS.late + 0.4) finishPass();
  }
  if (S.reviewing) {
    drawReview();
  } else if (S.mode === 'practice' && S.demo?.playing) {
    drawDemo();
  } else if (S.mode === 'practice') {
    const f = S.follower;
    if (S.listening && S.doneAt !== null && S.audio.currentTime > S.doneAt) stopPractice(true);
    // 弾いている最中は、飛ばした印（赤）は出さない。一瞬の迷子でも付くので、終わってから見直した結果で出す
    sheet.draw(S.chart, {
      pos: f.pos, conf: f.conf, listening: S.listening,
      played: S.listening ? f.played.map(x => (x === 2 ? 0 : x)) : S.finalPlayed ?? f.played,
      stumbleBars: S.listening ? null : S.lastStumbles,
    });
  } else {
    // カウントの何拍目か（はじめの1小節ぶん）
    let count = null;
    if (S.playing && S.range && S.song < S.range.from) {
      const c = countIn(S.range.from), left = Math.ceil((S.range.from - S.song) / c.beat - 1e-6);
      if (left >= 1 && left <= c.n) count = { k: c.n - left + 1, n: c.n };
    }
    if (gameSheet()) {
      sheet.draw(S.chart, { song: S.song, listening: S.playing, played: S.judge ? judgedGroups() : null, conf: 1, pos: -1 });
      if (count) drawCountIn(sheet.ctx, sheet.w, sheet.h, count);
    } else {
      view.draw(S.chart, S.judge, S.song, S.audio?.currentTime ?? 0, {
        loop: S.range && $('loop').checked ? S.range : null,
        countIn: count,
        playing: S.playing,
      });
    }
  }
  updateChrome();
}

/** 音ゲーモードをタブ譜で見せるか。タイミング合わせは線に合わせて弾くので、流れるレーンのまま */
function gameSheet() { return S.mode === 'game' && S.gameView === 'sheet' && !S.calibrating; }

/** 音ゲーの判定を和音ごとにまとめる（タブ譜の色分け用）。1 = 弾けた、2 = 外した音がある、0 = まだ */
function judgedGroups() {
  const st = S.judge.state;
  return Uint8Array.from(S.chart.groups, grp => {
    const rs = grp.noteIds.map(id => st[id].result);
    if (rs.includes('miss')) return 2;
    return rs.includes('hit') && rs.every(r => r !== null) ? 1 : 0;
  });
}

/** ctx 時刻 → 曲内時刻（止まっている間も正しく写す） */
function songAt(ctxT) {
  const h = S.history;
  if (h.length === 0) return S.song;
  if (ctxT >= h[h.length - 1][0]) return h[h.length - 1][1] + (ctxT - h[h.length - 1][0]) * speed();
  for (let i = h.length - 1; i > 0; i--) {
    if (h[i - 1][0] <= ctxT) {
      const [a, sa] = h[i - 1], [b, sb] = h[i];
      return sa + (sb - sa) * ((ctxT - a) / (b - a || 1));
    }
  }
  return h[0][1] - (h[0][0] - ctxT) * speed();
}

function onFrame(centerCtx, spec, flux) {
  if (S.mode === 'practice') {
    if (!S.listening) return;
    const ev = S.follower.step(centerCtx, spec, flux);
    if (ev) {
      S.diagMoves.push(ev);
      updatePracticeStats();
      // 最後の和音まで来たら、少し響きを待って終わる
      if (ev.pos === S.chart.groups.length - 1) S.doneAt = S.audio.currentTime + 2.5;
    }
    return;
  }
  if (!S.playing) return;
  const lat = S.calibrating ? 0 : S.latency;
  const t = songAt(centerCtx - lat);
  const events = S.judge.step(t, spec, flux);
  if (following()) S.flex.step(centerCtx - lat, songAt, spec, flux, speed());
  if (events.length === 0) return;
  const now = S.audio.currentTime;
  const L = view.layout(S.chart.stringCount, S.chart.voiced);
  for (const e of events) if (e.result === 'hit') view.hitFx(S.chart.notes[e.id], L, now);
  updateStats();
}

// ---- テンポを合わせる（音ゲーモード。中身は flex.js）----
function following() { return $('follow').checked && !S.calibrating; }

function tally() {
  const st = S.judge.state;
  let hit = 0, total = 0, dsum = 0;
  S.chart.notes.forEach((n, i) => {
    const r = st[i].result;
    if (r !== 'hit' && r !== 'miss') return;
    total++;
    if (r === 'hit') { hit++; dsum += st[i].delta; }
  });
  return { hit, total, mean: hit ? dsum / hit : 0 };
}

function updateStats() {
  if (!S.judge) return;
  const { hit, total, mean } = tally();
  $('acc').textContent = total ? `${Math.round((hit / total) * 100)}%` : '';
  $('count').textContent = total ? `${hit} / ${total}` : '';
  $('timing').textContent = S.playing && following() && hit >= 3 ? `テンポ ${Math.round(speed() * S.flex.k * 100)}%`
    : hit >= 3 ? timingLabel(mean) : '';
}

function timingLabel(mean) {
  const ms = Math.round(mean * 1000);
  if (Math.abs(ms) < 20) return 'タイミング ぴったり';
  return `平均 ${Math.abs(ms)}ms ${ms < 0 ? '早い' : '遅い'}`;
}

function finishPass() {
  if (S.calibrating) return finishCalibration();
  S.passes.push(snapshot());
  const take = S.take, m = S.passMap;
  S.take = null;
  if (take?.start != null) {
    const data = gameReview(S.chart, S.judge, t => songToCtx(m, t) + m.lat - take.start, m.speed, take.length / take.sr);
    S.lastReview = { ...reviewInfo(take, data), diag: gameDiag(S.judge, S.range, m, data) };
  }
  if (S.drill) recordDrill();
  else { S.hub = null; S.beforeDrill = null; updateBackButton(); } // 通して弾き終えたら、振り返りはこの回のものに
  if ($('loop').checked) { begin(); return; }
  stop();
  showResult();
}

function snapshot() {
  const bars = new Map();
  S.chart.notes.forEach((n, i) => {
    const r = S.judge.state[i].result;
    if (r !== 'hit' && r !== 'miss') return;
    const b = bars.get(n.bar) || { hit: 0, total: 0 };
    b.total++; if (r === 'hit') b.hit++;
    bars.set(n.bar, b);
  });
  return { ...tally(), bars };
}

function showResult() {
  const p = S.passes[S.passes.length - 1];
  if (!p || p.total === 0) return;
  $('r-acc').textContent = `${Math.round((p.hit / p.total) * 100)}%`;
  $('r-sub').textContent = `${p.hit} / ${p.total} 音` + (p.hit >= 3 ? `・${timingLabel(p.mean)}` : '');
  const rows = [...p.bars.entries()].map(([bi, b]) => ({ bi, rate: b.hit / b.total, ...b }));
  $('r-bars').innerHTML = rows.map(r => {
    const bar = S.chart.bars[r.bi];
    const pct = Math.round(r.rate * 100);
    return `<button class="bar-cell ${pct < 60 ? 'bad' : pct < 90 ? 'mid' : 'good'}" data-bar="${r.bi}" title="${bar.number}小節 ${r.hit}/${r.total}">
      <span class="fill" style="--p:${pct}%"></span><span class="num">${bar.number}</span></button>`;
  }).join('');
  const weak = rows.filter(r => r.rate < 0.9).sort((a, b) => a.rate - b.rate).slice(0, 3);
  $('r-weak').innerHTML = weak.length
    ? '苦手なところ: ' + weak.map(r => `<button class="link" data-bar="${r.bi}">${S.chart.bars[r.bi].number}小節（${Math.round(r.rate * 100)}%）</button>`).join(' ')
    : 'ぜんぶ9割以上。通して弾けています。';
  $('result').hidden = false;
}

function practiceBar(bi) {
  // 振り返りの一覧を残して、あとで「← 振り返りに戻る」で戻れるようにする
  if (!S.hub && S.lastReview) S.hub = makeHub(S.lastReview);
  closeReview();
  // 範囲・くり返し・速さを書き換える前の設定を覚えておく（小節から小節へ移るときは、最初のものを残す）
  if (!S.beforeDrill) S.beforeDrill = { mode: S.mode, from: $('from').value, to: $('to').value, loop: $('loop').checked, speed: $('speed').value };
  S.drill = { bar: bi };
  updateBackButton();
  if (S.mode !== 'game') setMode('game');
  const a = Math.max(0, bi - 0), b = Math.min(S.chart.bars.length - 1, bi);
  $('from').value = String(a); $('to').value = String(b);
  $('loop').checked = true;
  if (Number($('speed').value) > 80) $('speed').value = '70';
  syncSpeedLabel();
  $('result').hidden = true;
  $('presult').hidden = true;
  S.song = S.chart.bars[a].t - 0.5;
  S.judge.reset(S.chart.bars[a].t);
}

// ---- タイミング合わせ ----
async function calibrate() {
  try { await ensureAudio(); } catch (e) { micError(e); return; }
  closeSettings();
  const mode = S.mode;
  if (mode !== 'game') setMode('game'); // 線に合わせて弾くので、音ゲーの画面で
  const tex = `\\tempo 90 . \\track "G" \\staff {tabs} \\tuning e4 b3 g3 d3 a2 e2
0.1.4 0.1.4 0.1.4 0.1.4 | 0.1.4 0.1.4 0.1.4 0.1.4 | 0.1.4 0.1.4 0.1.4 0.1.4`;
  S.calibrating = { score: S.score, trackIndex: S.trackIndex, title: $('title').textContent, speed: $('speed').value, mode, songFile: S.songFile, songId: S.songId };
  $('speed').value = '100'; syncSpeedLabel();
  S.score = scoreFromAlphaTex(tex);
  S.chart = buildChart(S.score, 0);
  $('title').textContent = 'タイミング合わせ — 1弦の開放を、線に重なる瞬間に弾いてください';
  S.range = { from: 0, to: S.chart.duration };
  S.passes = [];
  $('result').hidden = true;
  begin();
}

function finishCalibration() {
  const ds = S.chart.notes.map((n, i) => S.judge.state[i]).filter(s => s.result === 'hit').map(s => s.delta).sort((a, b) => a - b);
  const back = S.calibrating;
  S.calibrating = null;
  stop();
  if (ds.length >= 6) {
    S.latency = Math.max(0, Math.min(0.4, ds[Math.floor(ds.length / 2)]));
    store.set('latency', S.latency);
    toast(`合わせました: マイクの遅れ ${Math.round(S.latency * 1000)}ms`);
  } else {
    toast(`音がうまく拾えませんでした（${ds.length}/12）。マイクを近づけてもう一度どうぞ`);
  }
  $('speed').value = back.speed; syncSpeedLabel();
  if (back.score) { setScore(back.score, back.title); setTrack(back.trackIndex); $('track').value = String(back.trackIndex); S.songFile = back.songFile; S.songId = back.songId; }
  if (back.mode !== S.mode) setMode(back.mode);
  $('lat').textContent = `${Math.round(S.latency * 1000)}ms`;
}

// ---- 練習モード（譜面が演奏についてくる）----
function setMode(mode) {
  closeReview();
  stopDemo();
  if (S.playing) stop();
  if (S.listening) stopPractice(false);
  S.mode = mode;
  store.set('mode', mode);
  document.body.dataset.mode = mode;
  document.querySelectorAll('[data-mode-btn]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.modeBtn === mode)));
  setPlayLabel();
  $('result').hidden = true;
  $('presult').hidden = true;
  if (mode === 'practice') updatePracticeStats(); else updateStats();
}

function togglePlay() {
  if (S.reviewing) return S.hub.playing ? reviewPause() : reviewPlay(S.hub.pos);
  if (S.mode === 'practice' && S.demo?.playing) return pauseDemo();
  if (S.mode === 'practice') return S.listening ? stopPractice(true) : startPractice();
  return S.playing ? stop() : start();
}

async function startPractice(fromBar = Number($('from').value)) {
  try {
    await ensureAudio();
  } catch (e) {
    micError(e);
    return;
  }
  stopDemo();
  const first = Math.max(0, S.chart.groups.findIndex(g => g.bar >= fromBar));
  sheet.follow();
  S.follower = new Follower(S.chart);
  S.follower.start(first);
  S.diagMoves = [];
  S.take = newTake();
  S.finalPlayed = null;
  S.lastStumbles = null;
  S.listening = true;
  S.doneAt = null;
  S.practiceStart = S.audio.currentTime;
  $('presult').hidden = true;
  setPlayLabel();
  updatePracticeStats();
}

function stopPractice(showResult) {
  if (!S.listening) return;
  S.listening = false;
  S.doneAt = null;
  setPlayLabel();
  const st = S.follower.stumbles();
  S.lastStumbles = new Set(st.filter(s => s.score >= 1).map(s => s.bar));
  S.finalPlayed = S.follower.playedFromPath();
  const take = S.take;
  S.take = null;
  if (take?.start != null) {
    const data = practiceReview(S.chart, S.follower, { samples: take.samples(), sampleRate: take.sr, t0: take.start });
    S.lastReview = { ...reviewInfo(take, data), diag: practiceDiag(S.follower, S.diagMoves, st, data) };
  }
  if (showResult) { S.hub = null; S.drill = null; S.beforeDrill = null; updateBackButton(); showPracticeResult(st); }
}

// ---- 再生（練習モード。譜面の音を鳴らす。弾いた音は聞き取らない）----
async function startDemo(fromBar = Number($('from').value)) {
  try { await ensureOutput(); } catch (e) { micError(e); return; }
  if (S.listening) stopPractice(false);
  $('presult').hidden = true;
  S.demo ??= new DemoPlayer(S.audio);
  S.demo.rate = demoSpeed();
  // 止めたところの小節から始めるなら、小節の頭ではなく止めた和音から続ける
  const resume = S.demoResume !== null && S.chart.groups[S.demoResume]?.bar === fromBar ? S.chart.groups[S.demoResume].t : null;
  S.demoResume = null;
  S.demo.start(S.chart, resume ?? S.chart.bars[fromBar].t);
  sheet.follow();
  setDemoLabel();
}

function stopDemo() {
  S.demoResume = null;
  if (!S.demo?.playing) return;
  S.demo.stop();
  setDemoLabel();
  updatePracticeStats();
}

/** 停止ボタン: 最初に戻らず、いま鳴っている和音で止める。次の「再生」と「弾きはじめる」はその小節から */
function pauseDemo() {
  if (!S.demo?.playing) return;
  const cur = Math.max(0, demoGroup());
  stopDemo();
  S.demoResume = cur;
  $('from').value = String(S.chart.groups[cur].bar);
  S.follower.start(cur);
  S.finalPlayed = null; S.lastStumbles = null;
  updatePracticeStats();
}

function demoSpeed() { return Number($('demo-speed').value) / 100; }

/** ⏮: 1小節目に戻る。鳴らしている途中なら、1小節目から鳴らし直す */
function demoTop() {
  $('from').value = '0';
  S.demoResume = null;
  sheet.follow();
  if (S.demo?.playing) { startDemo(0); return; }
  if (S.listening) return;
  S.follower.start(0);
  S.finalPlayed = null; S.lastStumbles = null;
  updatePracticeStats();
}

/** 再生でいま鳴っている和音（group） */
function demoGroup() {
  const d = S.demo, gs = S.chart.groups;
  let cur = gs.findIndex(g => g.t >= d.song0 - 1e-6);
  while (cur + 1 < gs.length && gs[cur + 1].t <= d.pos + 0.02) cur++;
  return cur;
}

/** 再生している位置を譜面に出す（鳴っている和音を、弾くときの「次の和音」と同じ色で） */
function drawDemo() {
  const d = S.demo;
  d.pump();
  if (d.done) { stopDemo(); return; }
  const gs = S.chart.groups;
  const cur = demoGroup();
  sheet.draw(S.chart, { pos: cur - 1, conf: 1, listening: true, demo: true, played: null, stumbleBars: null });
  const bar = S.chart.bars[gs[Math.max(0, cur)].bar];
  const acc = `${bar.number}小節`;
  if ($('acc').textContent !== acc) { $('acc').textContent = acc; $('count').textContent = '再生中'; $('timing').textContent = ''; }
  S.demoProgress = (cur + 1) / gs.length;
}

function setDemoLabel() {
  const on = !!S.demo?.playing;
  // スマホでも文字を出す。アイコンだけだと、隣の「弾きはじめる」と見分けにくい
  $('demo').innerHTML = `<svg class="i fill"><use href="${on ? '#i-stop' : '#i-play'}"/></svg>${on ? '停止' : '再生'}`;
  $('demo').classList.toggle('on', on);
}

function updatePracticeStats() {
  if (S.mode !== 'practice' || !S.follower) return;
  const f = S.follower;
  const g = S.chart.groups[Math.max(0, f.pos)];
  const total = S.chart.bars.length;
  $('acc').textContent = f.pos < 0 ? '' : `${S.chart.bars[g.bar].number}小節`;
  $('count').textContent = f.pos < 0 ? '' : `${g.bar + 1} / ${total}`;
  $('timing').textContent = f.pos > 3 ? `テンポ ${Math.round(100 / f.tempo)}%` : '';
}

function showPracticeResult(st) {
  const f = S.follower;
  const played = [...S.finalPlayed].filter(x => x === 1).length;
  const min = (S.audio.currentTime - S.practiceStart) / 60;
  $('p-sub').textContent = `${played} / ${S.chart.groups.length} 和音・${min < 1 ? Math.round(min * 60) + '秒' : min.toFixed(1) + '分'}` +
    (played > 8 ? `・テンポ ${Math.round(100 / f.tempo)}%` : '');
  const top = st.filter(s => s.score >= 1).slice(0, 6);
  $('p-title').textContent = top.length ? `つっかえたところが ${top.length} か所` : 'つっかえずに弾けました';
  $('p-ok').hidden = top.length > 0;
  $('p-list').innerHTML = top.map(s => {
    const tags = [s.hesitate && `止まった ×${s.hesitate}`, s.back && `弾き直し ×${s.back}`, s.skip && `飛ばした ×${s.skip}`].filter(Boolean)
      .map(t => `<span class="tag">${t}</span>`).join('');
    return `<li><b>${S.chart.bars[s.bar].number}小節</b><span class="tags">${tags}</span>
      <button data-bar="${s.bar}" title="音ゲーモードで、この小節を遅めにくり返す">この小節を練習 →</button></li>`;
  }).join('');
  $('presult').hidden = false;
}

// ---- 録音（実機での調整用に、弾いた音をそのまま wav で保存する）----
async function toggleRecord() {
  if (S.recorder) {
    const blob = S.recorder.stop();
    S.recorder = null;
    $('rec').innerHTML = '<span style="color:var(--bad)">●</span> 録音';
    $('rec-ind').hidden = true;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const name = `${($('title').textContent || 'flubato').replace(/[\\/:*?"<>|（）()]/g, '').trim().slice(0, 40)}-${stamp}.wav`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`保存しました: ${name}`);
    return;
  }
  try { await ensureAudio(); } catch (e) { micError(e); return; }
  S.recorder = new Recorder(S.audio.sampleRate);
  $('rec').textContent = '■ 止めて保存';
  $('rec-ind').hidden = false;
}

// ---- 調査用に保存（精度が悪かった回を、録音・曲・設定・アプリの判断ごと持ち帰る。tools/eval.mjs で動かし直せる）----
/**
 * 振り返り・調査用の録音を始める。マイクの直前の音（次の解析の窓とその前の1コマぶん）から録っておくと、
 * あとでアプリと同じ窓で解析し直せる
 */
function newTake() {
  const take = new Take(S.audio.sampleRate);
  const r = S.mic.recent();
  if (r.data.length) take.push(r.data, r.end);
  take.afterFrame = S.mic.lastFrameEnd; // これより後の窓から、この回の解析
  take.micPhase = S.mic.hopPhase; // まだ音が届いていなければ null（届いたときに mic.onSamples で埋める）
  return take;
}

function reviewInfo(take, data) {
  return { take, data, song: S.songFile, trackIndex: S.trackIndex, title: $('title').textContent };
}

function saveDiag(lr) {
  if (!lr?.diag || !lr.take.length) { toast('保存できる回がありません'); return; }
  const note = prompt('何が起きたか（任意）。例: 3小節目で止まっていないのに「止まった」になった', '');
  if (note === null) return;
  const t = lr.take;
  const common = {
    sampleRate: t.sr, takeStart: t.start, takeStartFrame: t.startFrame, afterFrame: t.afterFrame, micPhase: t.micPhase,
    title: lr.title,
    song: lr.song ? { name: lr.song.name, trackIndex: lr.trackIndex, bytes: toBase64(lr.song.bytes) } : null,
    settings: { latency: S.latency, strict: $('strict').value, speed: Number($('speed').value), device: $('device').selectedOptions[0]?.textContent ?? '' },
  };
  const blob = diagWav(t, common, lr.diag, note);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const name = `flubato-調査-${lr.title.replace(/[\\/:*?"<>|（）()]/g, '').trim().slice(0, 30)}-${lr.diag.kind === 'practice' ? '練習' : '音ゲー'}-${stamp}.wav`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast(`保存しました: ${name}`);
}

// ---- 振り返り（直前に通して弾いた回の録音を聞きながら、苦手な箇所を行き来して練習する）----
// S.hub: 苦手な箇所の一覧と録音。小節を練習（音ゲーの小節ループ）しに行っても残り、「← 振り返りに戻る」で戻れる。
// 次に通して弾き終えたら、その回のものに置き換わる
function makeHub(lr) {
  return {
    lr, data: lr.data, take: lr.take, buffer: null, spots: spots(S.chart, lr.data), spot: 0, selected: null,
    source: null, playing: false, startCtx: 0, pos: 0, stopAt: Infinity,
  };
}

function openReview() {
  if (!S.hub) {
    if (!S.lastReview || S.lastReview.take.length === 0) { toast('振り返る録音がありません'); return; }
    S.hub = makeHub(S.lastReview);
  }
  const h = S.hub;
  if (!h.buffer) {
    const samples = h.take.samples();
    h.buffer = S.audio.createBuffer(1, samples.length, h.take.sr);
    h.buffer.copyToChannel(samples, 0);
  }
  if (S.playing) stop();
  stopDemo();
  S.reviewing = true;
  $('result').hidden = true;
  $('presult').hidden = true;
  $('review').hidden = false;
  $('rv-side').hidden = false;
  document.body.classList.add('reviewing');
  sheet.resize();
  selectSpot(Math.min(h.spot, Math.max(0, h.spots.length - 1)), false);
  updateBackButton();
}

function closeReview() {
  if (!S.reviewing) return;
  reviewPause();
  S.reviewing = false;
  $('review').hidden = true;
  $('rv-side').hidden = true;
  document.body.classList.remove('reviewing');
  sheet.resize(); view.resize();
  updateBackButton();
}

function updateBackButton() {
  $('rv-back').hidden = !(S.hub && !S.reviewing);
  $('run-full').hidden = !(S.drill && !S.reviewing);
  $('drillbar').hidden = $('rv-back').hidden && $('run-full').hidden;
  $('drill-text').innerHTML = S.drill ? `<b>${S.chart.bars[S.drill.bar].number}小節</b> をくり返し練習中` : '振り返りの途中';
}

/**
 * 最初から通す。小節を練習しに行く前の範囲・くり返し・速さ（とモード）に戻して、すぐ始める。
 * 前の設定が残っていなければ、曲の頭から終わりまで・くり返しなしで
 */
function runFull() {
  const b = S.beforeDrill;
  closeReview();
  if (S.playing) stop();
  S.drill = null;
  S.beforeDrill = null;
  $('result').hidden = true;
  $('presult').hidden = true;
  const mode = b?.mode ?? S.mode;
  if (S.mode !== mode) setMode(mode);
  // 練習モードから来たときも、音ゲーの設定（範囲の終わり・くり返し・速さ）は戻しておく
  $('from').value = b?.from ?? '0';
  $('to').value = b?.to ?? String(S.chart.bars.length - 1);
  $('loop').checked = b?.loop ?? false;
  if (b) $('speed').value = b.speed;
  syncSpeedLabel();
  updateBackButton();
  if (mode === 'practice') startPractice(Number($('from').value));
  else start();
}

function renderSpots() {
  const h = S.hub;
  $('rv-list').innerHTML = h.spots.length ? h.spots.map((sp, i) => `<li data-i="${i}" aria-selected="${i === h.spot}">
      <b>${S.chart.bars[sp.bar].number}小節</b> <span class="hint">${escapeHtml(sp.summary)}</span>${sp.practice ? `<span class="done">✓ 練習 ${sp.practice.acc}%</span>` : ''}</li>`).join('')
    : '<li class="hint">苦手な箇所は見つかりませんでした</li>';
  $('rv-detail').hidden = !h.spots.length;
}

/** 苦手な箇所を選ぶ。play なら、その小節を録音で聞く */
function selectSpot(i, play) {
  const h = S.hub;
  renderSpots();
  if (!h.spots.length) return;
  h.spot = i;
  const sp = h.spots[i];
  h.selected = sp.groups[0];
  sheet.follow();
  renderSpots();
  $('rv-desc').textContent = sp.groups.map(g => describe(S.chart, h.data, g)).join('\n');
  if (play) listenSpot();
}

/** 選んだ小節を、少し前から小節の終わりまで聞く */
function listenSpot() {
  const h = S.hub, sp = h.spots[h.spot];
  if (!sp) return;
  const ts = h.data.groups.map((G, g) => (S.chart.groups[g].bar === sp.bar ? G.t : null)).filter(t => t !== null);
  if (!ts.length) { toast('この小節は弾いていないので、録音がありません'); return; }
  reviewPlay(Math.min(...ts) - 1, Math.max(...ts) + 1.5);
}

function reviewPos() {
  const h = S.hub;
  return h.playing ? S.audio.currentTime - h.startCtx : h.pos;
}

function reviewPlay(from, until = Infinity) {
  const h = S.hub;
  reviewPause();
  h.pos = Math.max(0, Math.min(from, h.buffer.duration - 0.05));
  h.stopAt = until;
  const src = S.audio.createBufferSource();
  src.buffer = h.buffer;
  src.connect(S.audio.destination);
  src.onended = () => { if (h.source === src) { h.pos = reviewPos(); h.playing = false; h.source = null; } };
  src.start(0, h.pos);
  h.source = src;
  h.startCtx = S.audio.currentTime - h.pos;
  h.playing = true;
}

function reviewPause() {
  const h = S.hub;
  if (!h?.source) return;
  h.pos = reviewPos();
  const src = h.source;
  h.source = null;
  h.playing = false;
  src.stop();
}

/** 譜面の和音を押したとき: その和音を選んで少し前から聞く（弾いていない和音なら選ぶだけ） */
function reviewSelect(g) {
  const h = S.hub;
  const i = h.spots.findIndex(sp => sp.bar === S.chart.groups[g].bar);
  if (i >= 0 && i !== h.spot) selectSpot(i, false);
  h.selected = g;
  const t = h.data.groups[g].t;
  if (t !== null) reviewPlay(t - 1);
}

function reviewStep(dir) {
  const h = S.hub;
  if (!h?.spots.length) return;
  selectSpot((h.spot + dir + h.spots.length) % h.spots.length, true);
}

function drawReview() {
  const h = S.hub;
  let t = reviewPos();
  if (h.playing && t >= h.stopAt) { reviewPause(); t = h.pos; }
  const cursor = groupAt(h.data, t);
  sheet.draw(S.chart, { pos: -1, listening: false, played: null, review: { data: h.data, cursor, selected: h.selected } });
  const fmt = x => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  $('rv-time').textContent = `${fmt(Math.max(0, t))} / ${fmt(h.buffer.duration)}`;
  const icon = h.playing ? '#i-pause' : '#i-play';
  if ($('rv-play').dataset.icon !== icon) { $('rv-play').dataset.icon = icon; $('rv-play').innerHTML = `<svg class="i fill"><use href="${icon}"/></svg>`; }
  // 選んだ和音の説明を出し続ける。何も選んでいなければ、再生位置の和音
  const g = h.selected ?? cursor;
  const text = g === null || g === undefined ? '和音を押すと、その少し前から聞けます' : describe(S.chart, h.data, g);
  if ($('rv-text').textContent !== text) $('rv-text').textContent = text;
}

/** 小節ループの1周が終わるたびに、その小節の出来を一覧に付ける */
function recordDrill() {
  const p = S.passes.at(-1), sp = S.hub?.spots.find(x => x.bar === S.drill.bar);
  const b = p?.bars.get(S.drill.bar);
  if (!sp || !b) return;
  sp.practice = { acc: Math.round((b.hit / b.total) * 100) };
}

// ---- UI ----
function syncSpeedLabel() { $('speed-v').textContent = `${$('speed').value}%`; syncRange($('speed')); }
/** スライダーのつまみの左側を塗る */
function syncSheetScale() { $('sheet-scale-v').textContent = `${$('sheet-scale').value}%`; syncRange($('sheet-scale')); }
function syncRange(el) { el.style.setProperty('--fill', `${((el.value - el.min) / (el.max - el.min)) * 100}%`); }

/** はじめる・とめるボタン。モードと、いま弾いているかで変える */
function setPlayLabel() {
  const live = S.mode === 'practice' ? S.listening : S.playing;
  const label = live ? (S.mode === 'practice' ? 'おわる' : 'とめる') : S.mode === 'practice' ? '弾きはじめる' : 'はじめる';
  $('play').innerHTML = `<svg class="i fill"><use href="${live ? '#i-stop' : '#i-play'}"/></svg>${label}<kbd>Space</kbd>`;
  document.body.classList.toggle('live', live);
}

/** 毎フレーム: マイクの音量・曲の進み具合 */
const micBars = [...document.querySelectorAll('.mic .bars i')];
function updateChrome() {
  // 音量は dB で見せる（-60dB〜-10dB）。内蔵マイクは自動の音量調整を切ると小さく、そのままの大きさでは動いて見えない
  const rms = S.mic ? S.mic.level / 4 : 0;
  const lv = rms > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 50)) : 0;
  // 弾いている最中にマイクから何も来ない（無音のまま）なら、選んでいるマイクが違うと知らせる
  if (S.mic && (S.listening || S.playing) && !S.quietWarned) {
    const now = performance.now();
    if (rms > 1e-4) S.quietSince = null;
    else if (S.quietSince === null) S.quietSince = now;
    else if (now - S.quietSince > 4000) {
      S.quietWarned = true;
      toast(`マイク（${S.mic.label || '既定のマイク'}）から音が届いていません。右上のマイクのボタンから、使うマイクを選び直してください`);
    }
  }
  document.body.style.setProperty('--lv', lv.toFixed(3));
  document.body.classList.toggle('mic-on', !!S.mic);
  micBars.forEach((b, k) => b.classList.toggle('on', lv > 0.04 + k * 0.16));
  let p = 0;
  if (S.reviewing) p = S.hub?.buffer ? reviewPos() / S.hub.buffer.duration : 0;
  else if (S.mode === 'practice' && S.demo?.playing) p = S.demoProgress ?? 0;
  else if (S.mode === 'practice') p = S.follower && S.follower.pos >= 0 ? (S.follower.pos + 1) / S.chart.groups.length : 0;
  else if (S.range && S.playing) p = (S.song - S.range.from) / (S.range.to - S.range.from);
  $('progress').style.setProperty('--p', Math.max(0, Math.min(1, p)).toFixed(4));
}

// ---- 設定（右から出る）----
function openSettings() {
  closeLibrary();
  $('settings').hidden = false; $('scrim').hidden = false;
  updateMicInfo();
  updateDataInfo();
}
async function updateDataInfo() {
  const songs = await listSongs().catch(() => []);
  const mb = songs.reduce((a, s) => a + s.size, 0) / 1024 / 1024;
  $('data-info').textContent = `保存した曲（${songs.length}曲・${mb < 0.1 ? '0.1MB未満' : `${mb.toFixed(1)}MB`}）と、設定（マイクの遅れの測った値など）を消して、はじめて開いたときの状態に戻します。`;
}
async function clearAllData() {
  if (!confirm('保存した曲と設定をすべて消します。元には戻せません。消しますか？')) return;
  try {
    await clearSongs();
    for (const k of Object.keys(localStorage)) if (k.startsWith('flubato.')) localStorage.removeItem(k);
  } catch (e) {
    console.error(e);
    toast('消せませんでした');
    return;
  }
  location.reload();
}
function closeSettings() { $('settings').hidden = true; $('scrim').hidden = true; }

// ---- チューナー ----
// 針の目盛り（±50 セントを ±60° に振る）
$('tuner').querySelector('.tn-ticks').innerHTML = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50].map(c => {
  const a = c * 1.2 * Math.PI / 180;
  const at = r => [(100 + r * Math.sin(a)).toFixed(1), (100 - r * Math.cos(a)).toFixed(1)];
  const [x1, y1] = at(78), [x2, y2] = at(Math.abs(c) === 50 || c === 0 ? 62 : 68);
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${c === 0 ? ' class="mid"' : ''}/>`;
}).join('');

async function openTuner() {
  if (S.reviewing && S.hub.playing) reviewPause();
  if (S.listening) stopPractice(false);
  if (S.playing) stop();
  if (S.demo?.playing) stopDemo();
  closeLibrary();
  $('tuner').hidden = false;
  showTuner(null);
  try { await ensureAudio(); } catch (e) { micError(e); closeTuner(); return; }
  if ($('tuner').hidden) return; // マイクの許可を待つあいだに閉じた
  S.tuner = new Tuner(S.audio.sampleRate);
  requestAnimationFrame(tunerTick);
}
function closeTuner() { $('tuner').hidden = true; S.tuner = null; }

let tunerLast = 0;
function tunerTick(now) {
  if (!S.tuner) return;
  requestAnimationFrame(tunerTick);
  if (now - tunerLast < 50) return; // 測るのは 1 秒に 20 回まで
  tunerLast = now;
  showTuner(S.tuner.read(now));
}

function showTuner(r) {
  const cents = r ? Math.max(-50, Math.min(50, r.note.cents)) : 0;
  $('tn-needle').style.transform = `rotate(${cents * 1.2}deg)`;
  $('tuner').dataset.state = !r ? 'none' : Math.abs(r.note.cents) <= 5 ? 'ok' : 'off';
  $('tn-note').innerHTML = r ? `${r.note.name}<sub>${r.note.octave}</sub>` : '—';
  $('tn-sub').textContent = r
    ? `${r.hz.toFixed(1)} Hz　${r.note.cents >= 0 ? '+' : '−'}${Math.abs(r.note.cents).toFixed(0)} セント`
    : S.mic ? '弦を1本だけ鳴らしてください' : 'マイクを準備しています';
}
let toastTimer;
function toast(msg) {
  $('toast').textContent = msg; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

$('file').addEventListener('change', e => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; });
$('track').addEventListener('change', e => {
  setTrack(Number(e.target.value));
  if (S.songId) touchSong(S.songId, { trackIndex: S.trackIndex }).catch(() => {});
});
$('lib-btn').addEventListener('click', openLibrary);
$('library-close').addEventListener('click', closeLibrary);
$('lib-list').addEventListener('click', async e => {
  const li = e.target.closest('[data-id]');
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.closest('.del')) {
    if (!confirm(`「${li.querySelector('b').textContent}」をライブラリから消しますか？`)) return;
    await removeSong(id).catch(e => console.error(e));
    if (S.songId === id) { S.songId = null; store.set('lastSong', null); }
    return renderLibrary();
  }
  if (!e.target.closest('.open')) return;
  try {
    if (id === 'demo') openDemo(); else await openSaved(id);
    closeLibrary();
  } catch (err) {
    console.error(err);
    toast('この曲を開けませんでした');
    renderLibrary();
  }
});
$('play').addEventListener('click', togglePlay);
$('demo').addEventListener('click', () => (S.demo?.playing ? pauseDemo() : startDemo()));
$('demo-top').addEventListener('click', demoTop);
$('demo-speed').addEventListener('change', () => {
  store.set('demoSpeed', Number($('demo-speed').value));
  S.demo?.setRate(demoSpeed());
});
$('speed').addEventListener('input', syncSpeedLabel);
$('zoom').addEventListener('input', e => { view.pps = Number(e.target.value); store.set('zoom', view.pps); syncRange(e.target); });
$('sheet-scale').addEventListener('input', e => { sheet.scale = Number(e.target.value) / 100; store.set('sheetScale', sheet.scale); syncSheetScale(); });
$('settings-btn').addEventListener('click', openSettings);
$('tuner-btn').addEventListener('click', openTuner);
$('tn-close').addEventListener('click', closeTuner);
$('mic-btn').addEventListener('click', async () => {
  openSettings();
  if (!S.mic) { try { await ensureAudio(); } catch (e) { micError(e); } }
});
$('mic-start').addEventListener('click', async () => { try { await ensureAudio(); } catch (e) { micError(e); } });
navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
$('settings-close').addEventListener('click', closeSettings);
$('clear-data').addEventListener('click', clearAllData);
$('scrim').addEventListener('click', () => { closeSettings(); closeLibrary(); });
$('rec-ind').addEventListener('click', toggleRecord);
$('strict').addEventListener('change', e => store.set('strict', e.target.value));
$('game-view').addEventListener('change', e => { S.gameView = e.target.value; store.set('gameView', S.gameView); sheet.follow(); });
$('follow').addEventListener('change', e => store.set('follow', e.target.checked));
$('calib').addEventListener('click', calibrate);
// マイクを選び直したら、その場で切り替える（弾いている途中でも、そのまま続けて聞く）
$('device').addEventListener('change', async () => {
  store.set('device', $('device').value);
  S.mic?.stop(); S.mic = null;
  updateMicInfo();
  try { await ensureAudio(); } catch (e) { micError(e); }
});
$('r-close').addEventListener('click', () => { $('result').hidden = true; });
$('p-close').addEventListener('click', () => { $('presult').hidden = true; });
$('p-again').addEventListener('click', () => startPractice());
$('p-list').addEventListener('click', e => { const b = e.target.closest('[data-bar]'); if (b) practiceBar(Number(b.dataset.bar)); });
$('rec').addEventListener('click', toggleRecord);
for (const id of ['p-review', 'r-review']) $(id).addEventListener('click', openReview);
$('rv-play').addEventListener('click', togglePlay);
$('rv-prev').addEventListener('click', () => reviewStep(-1));
$('rv-list').addEventListener('click', e => { const li = e.target.closest('[data-i]'); if (li) selectSpot(Number(li.dataset.i), true); });
$('rv-listen').addEventListener('click', listenSpot);
$('rv-diag').addEventListener('click', () => saveDiag(S.hub?.lr));
for (const id of ['p-diag', 'r-diag']) $(id).addEventListener('click', () => saveDiag(S.lastReview));
$('rv-drill').addEventListener('click', () => { const sp = S.hub?.spots[S.hub.spot]; if (sp) practiceBar(sp.bar); });
$('rv-back').addEventListener('click', () => { if (S.playing) stop(); openReview(); });
for (const id of ['run-full', 'rv-full']) $(id).addEventListener('click', runFull);
$('rv-next').addEventListener('click', () => reviewStep(1));
$('rv-close').addEventListener('click', closeReview);
document.querySelectorAll('[data-mode-btn]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.modeBtn)));
// 押せるところ（練習の小節・振り返りの和音）では指の形に
$('stage').addEventListener('mousemove', e => {
  const r = $('stage').getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const can = S.reviewing ? sheet.groupAt(x, y) !== null || sheet.barAt(x, y) !== null : S.mode === 'practice' && sheet.barAt(x, y) !== null;
  $('stage').style.cursor = can ? 'pointer' : '';
});
// 練習・振り返りの譜面は、ホイールや指でなぞって全体を見渡せる
const sheetShown = () => S.reviewing || S.mode === 'practice' || gameSheet();
$('stage').addEventListener('wheel', e => {
  if (!sheetShown()) return;
  e.preventDefault();
  sheet.fling(0);
  sheet.scrollBy(e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? $('stage').clientHeight : 1));
}, { passive: false });
let drag = null, dragged = false; // なぞった直後の click は、小節を選んだことにしない
$('stage').addEventListener('pointerdown', e => {
  dragged = false;
  if (!sheetShown() || e.button !== 0) return;
  drag = { id: e.pointerId, y0: e.clientY, y: e.clientY, t: e.timeStamp, v: 0 };
  sheet.fling(0);
});
$('stage').addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!dragged && Math.abs(e.clientY - drag.y0) < 8) return;
  if (!dragged) { dragged = true; $('stage').setPointerCapture(e.pointerId); }
  const dy = drag.y - e.clientY, dt = Math.max(1, e.timeStamp - drag.t);
  sheet.scrollBy(dy);
  drag.v = 0.8 * (dy / dt) + 0.2 * drag.v; // px/ms
  drag.y = e.clientY; drag.t = e.timeStamp;
});
const endDrag = e => {
  if (!drag || e.pointerId !== drag.id) return;
  // 指を止めてから離したときは、惰性で流さない
  if (dragged && e.timeStamp - drag.t < 80) sheet.fling(drag.v * 16);
  drag = null;
};
$('stage').addEventListener('pointerup', endDrag);
$('stage').addEventListener('pointercancel', endDrag);
$('stage').addEventListener('click', e => {
  if (dragged) { dragged = false; return; }
  const r = $('stage').getBoundingClientRect();
  if (S.reviewing) {
    const g = sheet.groupAt(e.clientX - r.left, e.clientY - r.top);
    if (g !== null) return reviewSelect(g);
    const bar = sheet.barAt(e.clientX - r.left, e.clientY - r.top);
    const first = bar === null ? -1 : S.chart.groups.findIndex((x, i) => x.bar === bar && S.hub.data.groups[i].t !== null);
    if (first >= 0) reviewSelect(first);
    return;
  }
  if (S.mode !== 'practice') return;
  const bar = sheet.barAt(e.clientX - r.left, e.clientY - r.top);
  if (bar === null) return;
  // 弾いている途中なら、その小節から追い直す。止まっていれば開始位置にする
  $('from').value = String(bar);
  S.demoResume = null;
  if (S.demo?.playing) { startDemo(bar); return; }
  if (S.listening) { S.follower.start(Math.max(0, S.chart.groups.findIndex(g => g.bar >= bar))); updatePracticeStats(); }
  else { S.follower.start(Math.max(0, S.chart.groups.findIndex(g => g.bar >= bar))); S.finalPlayed = null; S.lastStumbles = null; }
});
$('r-again').addEventListener('click', () => start());
for (const id of ['r-bars', 'r-weak']) {
  $(id).addEventListener('click', e => { const b = e.target.closest('[data-bar]'); if (b) practiceBar(Number(b.dataset.bar)); });
}
for (const id of ['from', 'to']) $(id).addEventListener('change', () => {
  S.demoResume = null;
  if (S.playing) return;
  const r = selectedRange();
  S.song = r.from - 0.5;
});
window.addEventListener('keydown', e => {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (!$('tuner').hidden) {
    if (e.key === 'Escape') closeTuner();
  } else if (e.code === 'Space' && !typing) {
    // ボタンにフォーカスがあってもスペースは「はじめる・とめる」に使う（押したボタンをもう一度押さない）
    e.preventDefault(); document.activeElement?.blur?.(); togglePlay();
  } else if (e.key === 'Escape') {
    if (!$('library').hidden) closeLibrary();
    else if (!$('settings').hidden) closeSettings();
    else if (!$('result').hidden) $('result').hidden = true;
    else if (!$('presult').hidden) $('presult').hidden = true;
    else if (S.reviewing) closeReview();
  } else if (S.reviewing && !typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault(); reviewStep(e.key === 'ArrowLeft' ? -1 : 1);
  }
});
// 窓の大きさだけでなく、上の帯の折り返し（スマホで曲名が変わったとき）で譜面の高さが変わっても描き直す
new ResizeObserver(() => { view.resize(); sheet.resize(); }).observe($('stage'));
// ファイルを画面にドロップして開く。dragenter / dragleave は下の要素を1つまたぐたびに対で届くので、
// 数を数えて、0 に戻ったら窓の外へ出たとみなす（dragleave だけで消すと、要素の境目で案内が点滅する）
let dragDepth = 0;
const isFileDrag = e => e.dataTransfer?.types.includes('Files');
window.addEventListener('dragenter', e => {
  if (!isFileDrag(e)) return;
  dragDepth++;
  document.body.classList.add('drag');
});
window.addEventListener('dragleave', e => {
  if (!isFileDrag(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('drag'); }
});
window.addEventListener('dragover', e => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0; document.body.classList.remove('drag');
  const f = e.dataTransfer.files[0]; if (f) openFile(f);
});

// 開いているあいだは画面を暗くしない（両手で弾いていると、画面に触らない時間が長い）
// 別のアプリに切り替えると外れるので、戻ってきたら取り直す。触る前だと断る端末もあるので、触ったときにも頼み直す
let wakeLock = null; // 取れている WakeLockSentinel か、頼んでいる途中なら 'pending'
async function keepAwake() {
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
  wakeLock = 'pending';
  try {
    const lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { wakeLock = null; });
    wakeLock = lock;
  } catch { wakeLock = null; /* 省電力モードなどで断られたら、ふつうに暗くなる */ }
}
document.addEventListener('visibilitychange', keepAwake);
window.addEventListener('pointerdown', keepAwake);
keepAwake();

// ---- 新しい版に上げる ----
// 開いたとき・ほかのアプリから戻ってきたとき・開きっぱなしなら30分ごとに、公開中の版を確かめ、違っていれば読み込み直す。
// 弾いている・再生している・振り返りや結果を見ているあいだは読み込み直さず、手が空いたら読み込み直す
let pendingUpdate = null; // 読み込み直すのを待っている新しい版
const busy = () => S.playing || S.listening || S.demo?.playing || S.reviewing || S.calibrating || S.recorder
  || !$('tuner').hidden || !$('result').hidden || !$('presult').hidden;
function showBuild(latest) {
  if (!BUILD) return;
  const b = describeBuild(BUILD);
  const commit = BUILD.sha && !BUILD.dirty
    ? `<a href="https://github.com/uphy/flubato/commit/${BUILD.sha}" target="_blank" rel="noopener">${b.commit}</a>` : b.commit;
  $('build-info').innerHTML = commit;
  $('build-time').textContent = `${b.when} にビルド`;
  if (latest === undefined) return;
  if (!latest) $('update-state').textContent = '公開中の版を確かめられませんでした（電波がないときなど）';
  else if (latest.id === BUILD.id) $('update-state').textContent = '最新の版です';
  else { const n = describeBuild(latest); $('update-state').textContent = `新しい版 ${n.commit}（${n.when}）があります`; }
}
async function checkUpdate(manual = false) {
  if (!BUILD) return;
  const latest = await latestBuild();
  showBuild(latest);
  if (!latest || latest.id === BUILD.id) return;
  // 自分で「確かめる」を押したときは、前に同じ版で読み込み直していても、もう一度読み込み直す
  if (!manual && !shouldReload(latest)) return;
  pendingUpdate = latest;
  applyUpdate();
}
function applyUpdate() {
  if (!pendingUpdate || busy()) return;
  const latest = pendingUpdate; pendingUpdate = null;
  toast('新しい版を読み込んでいます');
  reloadTo(latest);
}
showBuild();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });
setInterval(applyUpdate, 2000);
// 開きっぱなしにしている（PC のタブなど）ときも、ときどき確かめる
setInterval(() => { if (document.visibilityState === 'visible') checkUpdate(); }, 30 * 60 * 1000);
$('check-update').addEventListener('click', () => { $('update-state').textContent = '確かめています…'; checkUpdate(true); });

view.pps = store.get('zoom', 240); $('zoom').value = String(view.pps); syncRange($('zoom'));
sheet.scale = store.get('sheetScale', 1); $('sheet-scale').value = String(Math.round(sheet.scale * 100)); syncSheetScale();
$('strict').value = store.get('strict', 'normal');
$('game-view').value = S.gameView;
$('demo-speed').value = String(store.get('demoSpeed', 100));
$('follow').checked = store.get('follow', true);
$('lat').textContent = `${Math.round(S.latency * 1000)}ms`;
syncSpeedLabel();
setDemoLabel();
refreshDevices(); // 前に許可をもらっていれば、マイクの名前の一覧が取れる
updateMicInfo();
// 前に開いていた曲をライブラリから開く。なければ（消した・保存できなかった）デモ
const lastSong = store.get('lastSong', null);
if (lastSong) await openSaved(lastSong).catch(e => { console.error(e); openDemo(); });
else openDemo();
setMode(S.mode);
requestAnimationFrame(tick);
checkUpdate();

// テスト用の口
window.__flubato = { S, sheet, start, stop, startPractice, stopPractice, startDemo, stopDemo, setMode };
