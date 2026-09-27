// alphaTex（テキストで書いたタブ譜）を Guitar Pro 7 形式（.gp）に書き出す。
// PDF の構造化フェーズの出口として使う想定: PDF → alphaTex → .gp
//   node tools/tex2gp.mjs in.tex [out.gp]
import fs from 'node:fs';
import { scoreFromAlphaTex, exportGp7, buildChart } from '../src/chart.js';

const [src, dst = src.replace(/\.tex$/, '') + '.gp'] = process.argv.slice(2);
if (!src) { console.error('使い方: node tools/tex2gp.mjs in.tex [out.gp]'); process.exit(1); }
const score = scoreFromAlphaTex(fs.readFileSync(src, 'utf8'));
fs.writeFileSync(dst, exportGp7(score));
const c = buildChart(score, 0);
console.log(`${dst}: ${c.bars.length} 小節 / ${c.notes.length} 音 / ${c.duration.toFixed(1)} 秒`);
