// Guitar Pro などを alphaTab で読み、「何秒目に何弦の何フレットを弾くか」の譜面に直す。
// 繰り返し記号・テンポ変化は alphaTab の再生順（tickLookup）に任せる。
import * as at from '@coderline/alphatab';

const TICKS_PER_QUARTER = 960;

// ナチュラルハーモニクスのフレット → 開放弦から何半音上が鳴るか
const NATURAL_HARMONIC = { 12: 12, 7: 19, 19: 19, 5: 24, 24: 24, 4: 28, 9: 28, 16: 28, 3: 31 };

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
 * notes: { id, t, dur, string(1=1弦), fret, midi, kind('normal'|'dead'|'harmonic'|'legato'), group, bar }
 * bars:  { t, index(0始まり), number(表示用) } を再生順に
 * group: 同時に弾く音のまとまり（和音）。groups[g] = { t, noteIds }
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
  const rawRhythm = []; // 譜面にリズムを描くための拍（休符も） { bar, tick, t, duration, dots, tuplet, rest }
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
    for (let bl = mb.firstBeat; bl; bl = bl.nextBeat) {
      for (const item of bl.highlightedBeats) {
        const beat = item.beat;
        if (beat.voice.bar.staff.track.index !== trackIndex) continue;
        rawRhythm.push({
          bar: bars.length - 1, tick: item.playbackStart, t: tickToSec(mb.start + item.playbackStart),
          duration: beat.duration, dots: beat.dots, tuplet: beat.hasTuplet ? beat.tupletNumerator : 0,
          rest: beat.isRest || beat.notes.length === 0,
        });
        if (beat.isRest || beat.notes.length === 0) continue;
        const startTick = mb.start + item.playbackStart;
        const t = tickToSec(startTick);
        const dur = Math.max(0.05, tickToSec(startTick + beat.playbackDuration) - t);
        const ids = [];
        for (const n of beat.notes) {
          if (n.isTieDestination) continue; // 前の音をのばしているだけ
          const guitarString = stringCount - n.string + 1;
          const open = tuning[guitarString - 1] + capo;
          let kind = 'normal';
          let midi = n.realValue;
          if (n.isDead) kind = 'dead';
          else if (n.harmonicType === at.model.HarmonicType.Natural && NATURAL_HARMONIC[n.fret] !== undefined) {
            kind = 'harmonic';
            midi = open + NATURAL_HARMONIC[n.fret];
          } else if (n.isHammerPullDestination || n.isSlurDestination || n.slideOrigin) kind = 'legato';
          const id = notes.length;
          notes.push({ id, t, dur, string: guitarString, fret: n.fret, midi, kind, group: groups.length, bar: bars.length - 1 });
          ids.push(id);
        }
        if (ids.length > 0) groups.push({ t, noteIds: ids, bar: bars.length - 1 });
      }
      if (bl === mb.lastBeat) break;
    }
  }
  // 同じ時刻の group をまとめる（複数ボイスのときに分かれるため）
  const merged = [];
  for (const g of groups) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(prev.t - g.t) < 0.005) prev.noteIds.push(...g.noteIds);
    else merged.push({ t: g.t, noteIds: [...g.noteIds], bar: g.bar });
  }
  merged.forEach((g, i) => g.noteIds.forEach(id => { notes[id].group = i; }));

  // リズム: 小節の中の同じ位置の拍をまとめる。ボイスが複数あるとき（ベースをのばしながらメロディを刻む）は、
  // いちばん短い音価を出す（弾くタイミングが分かればいい）。どのボイスも休符なら休符
  const rhythm = [];
  for (const r of [...rawRhythm].sort((a, b) => a.bar - b.bar || a.tick - b.tick)) {
    const prev = rhythm[rhythm.length - 1];
    if (prev && prev.bar === r.bar && prev.tick === r.tick) {
      if (prev.rest && !r.rest) Object.assign(prev, { ...r });
      else if (prev.rest === r.rest && r.duration > prev.duration) Object.assign(prev, { duration: r.duration, dots: r.dots, tuplet: r.tuplet });
    } else rhythm.push({ ...r });
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
    rhythm,
    duration: last ? last.end : 0,
    beatSec: t => {
      let seg = segments[0];
      for (const s of segments) { if (s.sec <= t) seg = s; else break; }
      return 60 / seg.bpm;
    },
  };
}
