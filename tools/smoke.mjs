// ヘッドレス Chrome で開き、合成したギター演奏を「マイク入力」として流して、最後まで遊べるか見る。
//   node tools/smoke.mjs [out.png]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadScore, buildChart } from '../src/chart.js';
import { render, SR } from '../test/synth.mjs';
import { perform } from '../test/perform.mjs';
import { readWav } from './wav.mjs';
import { replayPractice, replayGame } from './replay.mjs';

const out = process.argv[2] ?? path.join(os.tmpdir(), 'flubato-smoke.png');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flubato-'));
const chart = buildChart(loadScore(new Uint8Array(fs.readFileSync('songs/romance.gp'))), 0);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn('node', ['tools/serve.mjs', '8771'], { stdio: 'ignore', env: { ...process.env, HOST: '127.0.0.1' } });

try {
  // 音ゲーモード: カウント（最初の小節の拍子ぶん）遅らせて、譜面どおりに弾いた音
  const lead = 0.1 + chart.bars[0].num * chart.beatSec(0) * (4 / chart.bars[0].den);
  const game = render(chart.notes.map(n => ({ t: n.t + lead, midi: n.midi, string: n.string, amp: n.string >= 5 ? 0.4 : 0.25 })), chart.duration + lead + 3);
  await scenario('game', game, async (evalJs, send, downloads) => {
    await evalJs(`window.__flubato.setMode('game'); window.__flubato.start()`);
    await sleep(9000);
    await shot(send, out.replace(/\.png$/, '-game-play.png'));
    // 途中から、練習モードと同じタブ譜の見た目に切り替える
    await evalJs(`const el = document.getElementById('game-view'); el.value = 'sheet'; el.dispatchEvent(new Event('change'))`);
    await sleep(3000);
    await shot(send, out.replace(/\.png$/, '-game-sheet.png'));
    await sleep((chart.duration + lead + 2) * 1000 - 12000);
    console.log('game:', await evalJs(`({ acc: document.getElementById('acc').textContent, count: document.getElementById('count').textContent, timing: document.getElementById('timing').textContent, result: !document.getElementById('result').hidden })`));
    await shot(send, out.replace(/\.png$/, '-game.png'));
    await review(evalJs, send, 'r-review', 'game', downloads);
  });

  // 練習モード: 人っぽく弾いた音（ゆっくりめ・途中で止まる・小節の頭から弾き直す）。時計に合わせる必要はない
  const perf = perform(chart, { lead: 2, tempo: g => 1.2 + 0.2 * Math.sin(g / 6), pause: { 20: 2.5 }, back: { 40: 36 } });
  await scenario('practice', render(perf.plays, perf.duration + 2), async (evalJs, send, downloads) => {
    await evalJs(`window.__flubato.setMode('practice'); window.__flubato.startPractice(0)`);
    await sleep(perf.steps[30].t * 1000);
    console.log('practice (途中):', await evalJs(`({ acc: document.getElementById('acc').textContent, pos: window.__flubato.S.follower.pos })`), '正解', perf.steps[30].g);
    await shot(send, out.replace(/\.png$/, '-practice-play.png'));
    await sleep((perf.duration + 4) * 1000 - perf.steps[30].t * 1000);
    console.log('practice:', await evalJs(`({ pos: window.__flubato.S.follower.pos, last: window.__flubato.S.chart.groups.length - 1, result: !document.getElementById('presult').hidden, title: document.getElementById('p-title').textContent, list: document.getElementById('p-list').innerText })`));
    await shot(send, out.replace(/\.png$/, '-practice.png'));
    await review(evalJs, send, 'p-review', 'practice', downloads);
  });
} finally {
  server.kill();
}

async function scenario(name, audio, body) {
  const wav = path.join(dir, `${name}.wav`);
  fs.writeFileSync(wav, toWav(audio, SR));
  const chrome = spawn(process.env.CHROME ?? 'google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=9333', `--user-data-dir=${dir}/prof-${name}`,
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`,
    '--autoplay-policy=no-user-gesture-required', '--window-size=1280,760', 'about:blank'], { stdio: 'ignore' });
  try {
    // Mac のヘッドレス Chrome は起動オプションだけではマイクを許可しないので、ブラウザ側で許可する。
    // 起動の直後（1.5秒）に送ると効かないので、少し待つ
    await sleep(2500);
    const version = await (await fetch('http://127.0.0.1:9333/json/version')).json();
    const bws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise(r => bws.addEventListener('open', r));
    await new Promise(r => { bws.addEventListener('message', r); bws.send(JSON.stringify({ id: 1, method: 'Browser.grantPermissions', params: { origin: 'http://127.0.0.1:8771', permissions: ['audioCapture'] } })); });
    // 「調査用に保存」のダウンロード先
    const downloads = path.join(dir, `dl-${name}`);
    fs.mkdirSync(downloads);

    bws.close();
    const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    let id = 0; const pending = new Map(); const errors = [];
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      // 「調査用に保存」のメモの入力
      if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: 99999, method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'smoke' } }));
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    });
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
    await send('Runtime.enable');

    await send('Page.enable');
    // 「調査用に保存」のダウンロード先（ブラウザ側の指定はヘッドレスでは効かず、~/Downloads に落ちる）
    await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await send('Page.navigate', { url: 'http://127.0.0.1:8771/' });
    await sleep(1500);
    await evalJs(`localStorage.setItem('flubato.latency', '0'); location.reload()`);
    await sleep(1500);
    await body(evalJs, send, downloads);
    console.log(`${name} errors:`, errors.length ? errors : 'なし');
    ws.close();
  } finally {
    chrome.kill();
    await sleep(500);
  }
}

// 結果から「録音で振り返る」を開き、次の苦手な箇所へ進めて再生が進むか、
// 小節を練習しに行って「← 振り返りに戻る」で一覧に戻れるかを見る
async function review(evalJs, send, button, name, downloads) {
  await evalJs(`document.getElementById('${button}').click()`);
  await sleep(300);
  await evalJs(`document.getElementById('rv-next').click()`);
  await sleep(1500);
  const state = () => evalJs(`({ reviewing: window.__flubato.S.reviewing, playing: window.__flubato.S.hub?.playing, spots: [...document.querySelectorAll('#rv-list li')].map(li => li.innerText.replace(/\\s+/g, ' ')), desc: document.getElementById('rv-desc').textContent, time: document.getElementById('rv-time').textContent })`);
  console.log(`${name} review:`, await state());
  await shot(send, out.replace(/\.png$/, `-${name}-review.png`));
  await evalJs(`document.getElementById('rv-drill').click()`);
  await sleep(300);
  console.log(`${name} drill:`, await evalJs(`({ mode: window.__flubato.S.mode, from: document.getElementById('from').value, to: document.getElementById('to').value, loop: document.getElementById('loop').checked, back: !document.getElementById('rv-back').hidden })`));
  // 「最初から通す」で、練習に行く前の範囲・くり返し・速さに戻って始まるか（見たあと、振り返りに戻して続ける）
  await evalJs(`document.getElementById('run-full').click()`);
  await sleep(500);
  console.log(`${name} full:`, await evalJs(`({ mode: window.__flubato.S.mode, from: document.getElementById('from').value, to: document.getElementById('to').value, loop: document.getElementById('loop').checked, speed: document.getElementById('speed').value, running: window.__flubato.S.playing || window.__flubato.S.listening, runFull: !document.getElementById('run-full').hidden })`));
  await evalJs(`window.__flubato.S.playing ? document.getElementById('play').click() : window.__flubato.stopPractice(false)`);
  await evalJs(`document.getElementById('rv-back').click()`);
  await sleep(300);
  console.log(`${name} back:`, await state());
  // 調査用に保存して、同じ条件で動かし直した結果がアプリの判断と同じか
  await evalJs(`document.getElementById('rv-diag').click()`);
  await sleep(1500);
  const file = fs.readdirSync(downloads).find(f => f.endsWith('.wav'));
  if (!file) console.log(`${name} diag: 保存されていない`, await evalJs(`document.getElementById('toast').textContent`));
  else {
    const { samples, sampleRate, meta } = readWav(path.join(downloads, file));
    if (meta.kind === 'practice') {
      const { moves } = replayPractice(meta, samples, sampleRate);
      const rec = meta.practice.moves;
      const same = rec.filter((m, i) => moves[i] && Math.abs(m.t - moves[i].t) < 0.002 && m.pos === moves[i].pos).length;
      console.log(`${name} diag: ${file} 動かし直した位置の一致 ${same} / アプリ ${rec.length}・いま ${moves.length}`);
    } else {
      const { judge } = replayGame(meta, samples, sampleRate);
      const same = meta.game.notes.filter((x, i) => x[0] === judge.state[i].result).length;
      console.log(`${name} diag: ${file} 動かし直した判定の一致 ${same} / ${meta.game.notes.length}`);
    }
  }
  await evalJs(`document.getElementById('rv-close').click()`);
}

async function shot(send, file) {
  const { result } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  console.log('screenshot:', file);
}

function toWav(samples, sr) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}
