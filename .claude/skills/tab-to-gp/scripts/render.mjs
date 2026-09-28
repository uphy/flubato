// alphaTex → PNG（確認用）と .gp（Guitar Pro 7）を書き出す
// usage: node render.mjs song.atex [width]
// 描画は確認用（原本と見比べる）。日本語のタイトルは描画用フォントに字形が無く崩れるが、.gp には影響しない
import * as alphaTab from '@coderline/alphatab';
import * as alphaSkia from '@coderline/alphaskia';
const { AlphaSkiaCanvas } = alphaSkia;
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const input = process.argv[2];
const width = Number(process.argv[3] ?? 1600);
const base = input.replace(/\.atex$/, '');

const fontDir = path.join(path.dirname(require.resolve('@coderline/alphatab')), 'font');
alphaTab.Environment.enableAlphaSkia(
  fs.readFileSync(path.join(fontDir, 'Bravura.otf')).buffer,
  alphaSkia
);

const settings = new alphaTab.Settings();
settings.core.engine = 'skia';
settings.core.enableLazyLoading = false;
settings.display.staveProfile = alphaTab.StaveProfile.Tab;
settings.notation.rhythmMode = alphaTab.TabRhythmMode.ShowWithBars;

const importer = new alphaTab.importer.AlphaTexImporter();
importer.initFromString(fs.readFileSync(input, 'utf8'), settings);
let score;
try {
  score = importer.readScore();
} catch (e) {
  console.error(e.diagnostics ? JSON.stringify(e.diagnostics, null, 1) : e);
  process.exit(1);
}

fs.writeFileSync(`${base}.gp`, new alphaTab.exporter.Gp7Exporter().export(score, settings));

const renderer = new alphaTab.rendering.ScoreRenderer(settings);
renderer.width = width;
const parts = [];
let total = { w: 0, h: 0 };
renderer.preRender.on(() => parts.length = 0);
renderer.partialRenderFinished.on(r => parts.push(r));
renderer.renderFinished.on(r => (total = { w: r.totalWidth, h: r.totalHeight }));
renderer.renderScore(score, [0]);

const canvas = new AlphaSkiaCanvas();
canvas.beginRender(total.w, total.h);
canvas.color = AlphaSkiaCanvas.rgbaToColor(255, 255, 255, 255);
canvas.fillRect(0, 0, total.w, total.h);
for (const p of parts) {
  const img = p.renderResult;
  if (img) canvas.drawImage(img, p.x, p.y, p.width, p.height);
}
const png = canvas.endRender().toPng();
fs.writeFileSync(`${base}.png`, Buffer.from(png));
console.log(`wrote ${base}.gp ${base}.png (${Math.round(total.w)}x${Math.round(total.h)})`);
