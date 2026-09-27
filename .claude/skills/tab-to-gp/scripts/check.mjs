// alphaTex の各小節・各声部の長さが拍子と合うか検査する
// usage: node check.mjs song.atex
import * as alphaTab from '@coderline/alphatab';
import fs from 'node:fs';

const settings = new alphaTab.Settings();
const importer = new alphaTab.importer.AlphaTexImporter();
importer.initFromString(fs.readFileSync(process.argv[2], 'utf8'), settings);
let score;
try {
  score = importer.readScore();
} catch (e) {
  console.error(e.diagnostics ? JSON.stringify(e.diagnostics, null, 1) : String(e));
  process.exit(1);
}
let bad = 0;
const staff = score.tracks[0].staves[0];
for (const bar of staff.bars) {
  const mb = score.masterBars[bar.index];
  const expect = mb.calculateDuration();
  bar.voices.forEach((v, vi) => {
    if (v.isEmpty) return;
    // 装飾音（{gr}）は拍の長さに数えない。playbackDuration は装飾音の分だけ前後の拍が削られるので、表記上の長さで数える
    const got = v.beats.filter(b => b.graceType === alphaTab.model.GraceType.None)
      .reduce((s, b) => s + b.displayDuration, 0);
    if (got !== expect) {
      bad++;
      console.log(`bar ${bar.index + 1} voice ${vi + 1}: ${got / 960} 拍 (期待 ${expect / 960} 拍)`);
    }
  });
}
console.log(`${staff.bars.length} bars, voices=${Math.max(...staff.bars.map(b => b.voices.length))}, NG ${bad}`);
process.exit(bad ? 1 : 0);
