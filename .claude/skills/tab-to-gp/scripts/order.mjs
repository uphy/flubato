// 再生の順（反復・D.S.・コーダを解いたあとの小節の並び）を出す。flubato も同じ alphaTab の再生順で譜面を作る
// usage: node order.mjs song.atex|song.gp
//   出力例: 170 bars: 1-56 → 2-17 → 57-92 → 37-55 → 93-135
import * as alphaTab from '@coderline/alphatab';
import fs from 'node:fs';

const input = process.argv[2];
const settings = new alphaTab.Settings();
let score;
if (input.endsWith('.atex')) {
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(fs.readFileSync(input, 'utf8'), settings);
  score = importer.readScore();
} else {
  score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(fs.readFileSync(input)), settings);
}

const gen = new alphaTab.midi.MidiFileGenerator(score, settings, new alphaTab.midi.AlphaSynthMidiFileHandler(new alphaTab.midi.MidiFile()));
gen.generate();
const nums = gen.tickLookup.masterBars.map(mb => mb.masterBar.index + 1);

// 続き番号をまとめる（1 2 3 5 6 → 1-3 → 5-6）
const runs = [];
for (const n of nums) {
  const last = runs.at(-1);
  if (last && n === last[1] + 1) last[1] = n;
  else runs.push([n, n]);
}
console.log(`${nums.length} bars: ${runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(' → ')}`);
