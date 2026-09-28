// Guitar Pro などを alphaTab で読み、「何秒目に何弦の何フレットを弾くか」の譜面に直す。
// 繰り返し記号・テンポ変化は alphaTab の再生順（tickLookup）に任せる。
import * as at from '@coderline/alphatab';

const TICKS_PER_QUARTER = 960;

// ナチュラルハーモニクスのフレット → 開放弦から何半音上が鳴るか
const NATURAL_HARMONIC = { 12: 12, 7: 19, 19: 19, 5: 24, 24: 24, 4: 28, 9: 28, 16: 28, 3: 31 };

// 強弱記号（alphaTab の DynamicValue の順）→ [書き方, 強さ（f を 0 とした段階）]
// sf・fp のように弾いた瞬間だけ強い記号は、弦を弾いた音では減り方を変えられないので、弾いた瞬間の強さで鳴らす
const DYNAMICS = [
  ['ppp', -5], ['pp', -4], ['p', -3], ['mp', -2], ['mf', -1], ['f', 0], ['ff', 1], ['fff', 2],
  ['pppp', -6], ['ppppp', -7], ['pppppp', -8], ['ffff', 3], ['fffff', 4], ['ffffff', 5],
  ['sf', 1], ['sfp', 1], ['sfpp', 1], ['fp', 0], ['rf', 1],
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const TUNING_NAMES = { EADGBE: 'レギュラー', DADGBE: 'ドロップD' };

/** 開放弦の高さ（MIDI。[0] が1弦）→ 6弦から並べた名前。よく使うものは呼び名にする（DADGAD はそのまま読める） */
export function tuningName(tuning) {
  const names = [...tuning].reverse().map(m => NOTE_NAMES[m % 12]);
  const joined = names.join('');
  return TUNING_NAMES[joined] ?? (names.some(n => n.length > 1) ? names.join(' ') : joined);
}

/** 曲を弾く前に合わせるもの（チューニングとカポ）。レギュラーでカポ無しなら null */
export function setupLabel(chart) {
  const name = tuningName(chart.tuning);
  if (name === 'レギュラー' && !chart.capo) return null;
  return [name === 'レギュラー' ? null : name, chart.capo ? `カポ ${chart.capo}` : null].filter(Boolean).join(' · ');
}

export function loadScore(bytes) {
  const settings = new at.Settings();
  return at.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
}

export function scoreFromAlphaTex(tex) {
  const settings = new at.Settings();
  const imp = new at.importer.AlphaTexImporter();
  imp.initFromString(tex, settings);
  return imp.readScore();
}

export function exportGp7(score) {
  return new at.exporter.Gp7Exporter().export(score, new at.Settings());
}

/** 弾ける（弦のある）トラックだけを返す */
export function guitarTracks(score) {
  return score.tracks
    .map((track, index) => ({ index, name: track.name || `Track ${index + 1}`, staff: track.staves[0] }))
    .filter(t => t.staff && t.staff.tuning && t.staff.tuning.length > 0 && !t.staff.isPercussion);
}

/**
 * 譜面を作る。
 * notes: { id, t, dur, string(1=1弦), fret, midi, kind('normal'|'dead'|'harmonic'|'legato'), legato, grace, staccato, letRing, palmMute, accent, tenuto, ghost, level, bend, group, bar, voice（0始まり） }
 *   dur: 書かれた長さ（タイでつないだ先まで）
 *   midi: 弾いた瞬間に鳴る高さ（プリベンドなら上げたあとの高さ）
 *   bend: チョーキングなら [{ t（音の頭から何秒）, semis（押さえたフレットから何半音上げているか） }]、なければ null
 *   legato: レガートの種類。'h'（ハンマリング）・'p'（プリング）・'s'（スライド）。前の音と同じフレットのスラーなど、どれでもなければ null
 *   grace: 装飾音なら { slot }。slot は本音符までに挟まる装飾音の数（0 = 本音符の直前）
 *   accent: 0 = なし、1 = アクセント（>）、2 = 強いアクセント（マルカート、^）
 *   ghost: ゴーストノート（かっこで囲んで、弱く弾く音）
 *   level: 強弱記号とクレッシェンドから決まる強さ。f を 0 に、1段階（mf → f など）を 1 として数える
 *   strum: ストロークで和音をずらして弾くとき、和音の時刻から何秒遅れて鳴るか（なければ 0）
 * bars:  { t, index(0始まり), number(表示用), voiced（符尾を上下に分ける） } を再生順に
 * group: 同時に弾く音のまとまり（和音）。groups[g] = { t, noteIds, bar, grace（装飾音だけの和音なら true）, stroke }
 *   stroke: ストローク（波線の矢印）なら { up（1弦から6弦へ）, arpeggio（ゆっくり分散させる） }、なければ null
 *   dynamic: 強弱記号（'mf' など）。前の和音から変わったところだけ。なければ null
 *   hairpin: クレッシェンドなら '<'、デクレッシェンドなら '>'、なければ null
 */
export function buildChart(score, trackIndex) {
  const settings = new at.Settings();
  const mf = new at.midi.MidiFile();
  const gen = new at.midi.MidiFileGenerator(score, settings, new at.midi.AlphaSynthMidiFileHandler(mf));
  gen.generate();

  const track = score.tracks[trackIndex];
  const stringCount = track.staves[0].tuning.length;
  const tuning = track.staves[0].tuning; // alphaTab の string=1 が最低音弦。tuning[0] が最高音弦
  const capo = track.staves[0].capo || 0;

  // tick → 秒。テンポ区間を積み上げる
  const segments = []; // { tick, sec, bpm }
  let lastTick = 0, lastSec = 0, lastBpm = score.tempo || 120;
  const pushTempo = (tick, bpm) => {
    lastSec += ((tick - lastTick) / TICKS_PER_QUARTER) * (60 / lastBpm);
    lastTick = tick;
    lastBpm = bpm;
    segments.push({ tick, sec: lastSec, bpm });
  };
  const lookups = gen.tickLookup.masterBars;
  for (const mb of lookups) {
    if (mb.tempoChanges.length === 0) continue;
    for (const tc of mb.tempoChanges) pushTempo(tc.tick, tc.tempo);
  }
  if (segments.length === 0) segments.push({ tick: 0, sec: 0, bpm: lastBpm });
  const tickToSec = tick => {
    let seg = segments[0];
    for (const s of segments) { if (s.tick <= tick) seg = s; else break; }
    return seg.sec + ((tick - seg.tick) / TICKS_PER_QUARTER) * (60 / seg.bpm);
  };

  const notes = [];
  const groups = [];
  const bars = [];
  const beats = []; // メトロノーム用 { t, first }
  const rawRhythm = []; // 譜面にリズムを描くための拍（休符も） { bar, tick, t, duration, dots, tuplet, rest, voice, strings }
  const idOf = new Map(); // alphaTab の音 → 最後に入れた notes の id（タイの先の長さを、つないだ元の音に足すため）
  for (const mb of lookups) {
    bars.push({
      t: tickToSec(mb.start), end: tickToSec(mb.end), index: mb.masterBar.index, number: mb.masterBar.index + 1,
      ticks: mb.end - mb.start, num: mb.masterBar.timeSignatureNumerator, den: mb.masterBar.timeSignatureDenominator,
    });
    const beatTicks = (TICKS_PER_QUARTER * 4) / mb.masterBar.timeSignatureDenominator;
    for (let k = 0; k < mb.masterBar.timeSignatureNumerator; k++) {
      const tick = mb.start + k * beatTicks;
      if (tick < mb.end) beats.push({ t: tickToSec(tick), first: k === 0 });
    }
    // highlightedBeats には、その刻みで鳴っている拍がすべて入る。別のボイスで細かく刻んでいると、
    // のばしている拍が刻みごとに出てくるので、1回の通り（masterBar の lookup）で1度だけ拾う
    const taken = new Set();
    for (let bl = mb.firstBeat; bl; bl = bl.nextBeat) {
      for (const item of bl.highlightedBeats) {
        const beat = item.beat;
        if (beat.voice.bar.staff.track.index !== trackIndex || taken.has(beat)) continue;
        taken.add(beat);
        const grace = beat.graceType !== at.model.GraceType.None;
        // 装飾音は拍の長さを持たないので、リズムの段には出さない
        if (!grace) rawRhythm.push({
          bar: bars.length - 1, tick: item.playbackStart, t: tickToSec(mb.start + item.playbackStart),
          duration: beat.duration, dots: beat.dots, tuplet: beat.hasTuplet ? beat.tupletNumerator : 0,
          rest: beat.isRest || beat.notes.length === 0, voice: beat.voice.index,
          strings: beat.notes.filter(n => !n.isTieDestination).map(n => stringCount - n.string + 1), // 符尾を伸ばす先の数字
        });
        if (beat.isRest || beat.notes.length === 0) continue;
        const startTick = mb.start + item.playbackStart;
        const t = tickToSec(startTick);
        // シャッフル（\tf）の小節では、鳴らす長さが書かれた音価と変わる（8分の組が 2:1 になる）。
        // alphaTab が再生用に割り出した範囲を使う
        const range = gen.tickLookup.getRelativeBeatPlaybackRange(beat);
        const durTicks = range ? range.endTick - range.startTick : beat.playbackDuration;
        const dur = Math.max(0.05, tickToSec(startTick + durTicks) - t);
        const ids = [];
        const strum = strumTicks(beat);
        for (const n of beat.notes) {
          if (n.isTieDestination) {
            // 前の音をのばしているだけ。元の音の長さをここまでのばす
            const o = idOf.get(n.tieOrigin);
            if (o !== undefined) {
              idOf.set(n, o);
              notes[o].dur = Math.max(notes[o].dur, t + dur - notes[o].t);
              // タイの先で戻す・上げ直すチョーキングは、元の音の続きとしてつなぐ
              if (n.hasBend) notes[o].bend = [...(notes[o].bend ?? [{ t: 0, semis: 0 }]), ...bendPoints(n, t - notes[o].t, dur)];
            }
            continue;
          }
          const guitarString = stringCount - n.string + 1;
          const open = tuning[guitarString - 1] + capo;
          let kind = 'normal';
          let midi = n.realValue;
          if (n.isDead) kind = 'dead';
          else if (n.harmonicType === at.model.HarmonicType.Natural && NATURAL_HARMONIC[n.fret] !== undefined) {
            kind = 'harmonic';
            midi = open + NATURAL_HARMONIC[n.fret];
          } else if (n.isHammerPullDestination || n.isSlurDestination || n.slideOrigin) kind = 'legato';
          const legato = kind === 'legato' ? legatoType(n) : null;
          const bend = kind !== 'harmonic' && n.hasBend ? bendPoints(n, 0, dur) : null;
          if (bend) midi += Math.round(bend[0].semis);
          const id = notes.length;
          // スタッカートは書かれた長さの半分で切る
          notes.push({
            id, t, dur: n.isStaccato ? Math.max(0.05, dur / 2) : dur, string: guitarString, fret: n.fret, midi, kind, legato,
            grace: grace ? { slot: 0 } : null, staccato: n.isStaccato, letRing: n.isLetRing, palmMute: n.isPalmMute,
            accent: n.accentuated === at.model.AccentuationType.Heavy ? 2 : n.accentuated === at.model.AccentuationType.Normal ? 1 : 0,
            tenuto: n.accentuated === at.model.AccentuationType.Tenuto, ghost: n.isGhost, level: 0, bend,
            strum: strum.has(n) ? tickToSec(startTick + strum.get(n)) - t : 0,
            group: groups.length, bar: bars.length - 1, voice: beat.voice.index,
          });
          idOf.set(n, id);
          ids.push(id);
        }
        const B = at.model.BrushType;
        const stroke = beat.brushType === B.None ? null
          : { up: beat.brushType === B.BrushUp || beat.brushType === B.ArpeggioUp, arpeggio: beat.brushType === B.ArpeggioUp || beat.brushType === B.ArpeggioDown };
        if (ids.length > 0) groups.push({ t, noteIds: ids, bar: bars.length - 1, stroke, dyn: beat.dynamics, cresc: beat.crescendo });
      }
      if (bl === mb.lastBeat) break;
    }
  }
  // 同じ時刻の group をまとめる（複数ボイスのときに分かれるため）
  const merged = [];
  for (const g of groups) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(prev.t - g.t) < 0.005) {
      prev.noteIds.push(...g.noteIds);
      prev.stroke ??= g.stroke;
      prev.cresc ||= g.cresc;
    } else merged.push({ t: g.t, noteIds: [...g.noteIds], bar: g.bar, stroke: g.stroke, dyn: g.dyn, cresc: g.cresc });
  }
  merged.forEach((g, i) => g.noteIds.forEach(id => { notes[id].group = i; }));
  merged.forEach(g => { g.grace = g.noteIds.every(id => notes[id].grace); });
  applyDynamics(merged, notes);
  // 装飾音が続くとき、本音符から数えて何番目か（描くときに左へずらして並べる）
  for (let i = merged.length - 1, slot = 0; i >= 0; i--) {
    const graces = merged[i].noteIds.filter(id => notes[id].grace);
    if (graces.length === 0) { slot = 0; continue; }
    graces.forEach(id => { notes[id].grace.slot = slot; });
    slot++;
  }

  // リズム: 音の入っているボイスが2つ以上ある小節（ベースをのばしながらメロディを刻む）は、いちばん若いボイスを
  // 上向きの符尾（up）、残りを下向きの符尾に分ける。休符しかないボイスは描かない。
  // 同じ向き・同じ位置の拍はまとめ、いちばん短い音価を出す。どのボイスも休符なら休符
  const voicesOf = bars.map(() => new Set());
  for (const r of rawRhythm) if (!r.rest) voicesOf[r.bar].add(r.voice);
  bars.forEach((b, i) => { b.voiced = voicesOf[i].size >= 2; });
  const rhythm = [];
  for (const r of [...rawRhythm].sort((a, b) => a.bar - b.bar || a.tick - b.tick)) {
    const used = voicesOf[r.bar];
    if (used.size ? !used.has(r.voice) : r.voice !== 0) continue;
    const up = bars[r.bar].voiced && r.voice === Math.min(...used);
    const prev = rhythm.slice(-2).find(x => x.bar === r.bar && x.tick === r.tick && x.up === up);
    const { voice, ...item } = r;
    if (!prev) { rhythm.push({ ...item, up, strings: [...r.strings] }); continue; }
    prev.strings.push(...r.strings);
    if (prev.rest && !r.rest) Object.assign(prev, { ...item, strings: prev.strings });
    else if (prev.rest === r.rest && r.duration > prev.duration) Object.assign(prev, { duration: r.duration, dots: r.dots, tuplet: r.tuplet });
  }

  const last = bars[bars.length - 1];
  return {
    title: score.title || '',
    artist: score.artist || '',
    trackName: track.name,
    stringCount,
    tuning: [...tuning], // 開放弦の高さ（MIDI）。[0] が1弦
    capo,
    tempo: segments[0].bpm,
    notes,
    groups: merged,
    bars,
    beats,
    rhythm, // { bar, tick, t, duration, dots, tuplet, rest, up（上向きの符尾）, strings（その拍で数字を書く弦） }
    voiced: bars.some(b => b.voiced), // 符尾を上下に分ける小節がある
    duration: last ? last.end : 0,
    beatSec: t => {
      let seg = segments[0];
      for (const s of segments) { if (s.sec <= t) seg = s; else break; }
      return 60 / seg.bpm;
    },
  };
}

/** レガートで弾く音が、前の音からハンマリング・プリング・スライドのどれでつながるか。ハンマリングとプリングは、前の音よりフレットが上か下かで分ける */
function legatoType(n) {
  if (n.slideOrigin) return 's';
  const from = n.hammerPullOrigin ?? n.slurOrigin;
  if (!from || from.fret === n.fret) return null;
  return from.fret < n.fret ? 'h' : 'p';
}

/**
 * ストロークで、和音の音ごとに何 tick 遅らせて鳴らすか（alphaTab の再生と同じ割り振り）。
 * ダウンは低い弦から、アップは高い弦から、brushDuration を音の数で割った間隔で順に鳴らす
 */
function strumTicks(beat) {
  const out = new Map();
  if (beat.brushType === at.model.BrushType.None) return out;
  const down = beat.brushType === at.model.BrushType.BrushDown || beat.brushType === at.model.BrushType.ArpeggioDown;
  const ns = beat.notes.filter(n => !n.isTieDestination).sort((a, b) => down ? a.string - b.string : b.string - a.string);
  const step = ns.length > 1 ? Math.floor(beat.brushDuration / (ns.length - 1)) : 0;
  ns.forEach((n, k) => out.set(n, k * step));
  return out;
}

/**
 * 和音ごとの強弱記号とクレッシェンドを、描く印（dynamic・hairpin）と音の強さ（level）にする。
 * alphaTab は何も書いていない拍を f として読むので、曲の頭が f なら記号は出さない
 */
function applyDynamics(groups, notes) {
  const C = at.model.CrescendoType;
  let prev = at.model.DynamicValue.F;
  for (const g of groups) {
    const d = DYNAMICS[g.dyn] ?? DYNAMICS[at.model.DynamicValue.F];
    g.dynamic = g.dyn !== prev ? d[0] : null;
    g.level = d[1];
    g.hairpin = g.cresc === C.Crescendo ? '<' : g.cresc === C.Decrescendo ? '>' : null;
    prev = g.dyn;
  }
  // クレッシェンドの続く和音は、次の強弱記号へ向けて少しずつ強さを変える。
  // 次に記号がない（か向きが合わない）ときは1段階ぶん変える
  for (let a = 0; a < groups.length;) {
    const dir = groups[a].hairpin;
    let b = a;
    while (dir && groups[b + 1]?.hairpin === dir) b++;
    if (dir) {
      const base = groups[a].level, sign = dir === '<' ? 1 : -1, after = groups[b + 1];
      const marked = after?.dynamic && Math.sign(after.level - base) === sign;
      const target = marked ? after.level : base + sign;
      // 次に記号があれば、その和音で届く。なければクレッシェンドの最後の和音で届き、次の記号まで保つ
      for (let i = a; i <= b; i++) groups[i].level = base + (target - base) * (i - a + (marked ? 0 : 1)) / (b - a + 1);
      if (!marked) for (let j = b + 1; j < groups.length && !groups[j].dynamic && !groups[j].hairpin; j++) groups[j].level = target;
    }
    a = b + 1;
  }
  for (const g of groups) {
    for (const id of g.noteIds) notes[id].level = g.level;
    delete g.dyn; delete g.cresc;
  }
}

/** チョーキングの点を、音の頭から t0 秒・長さ dur 秒の音の上の { t, semis } にする（alphaTab の値は 1/4 音単位、位置は 0〜60） */
function bendPoints(n, t0, dur) {
  return n.bendPoints.map(p => ({ t: t0 + (p.offset / at.model.BendPoint.MaxPosition) * dur, semis: p.value / 2 }));
}
