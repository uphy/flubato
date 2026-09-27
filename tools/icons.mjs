// public/icon.svg から PNG のアイコンを作る。アイコンの絵を変えたら動かして、できた PNG を commit する。
//   node tools/icons.mjs
// iOS のホーム画面は SVG のアイコンを使えないので PNG が要る。rsvg-convert（librsvg。Mac では brew install librsvg）で描く。
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = resolve(fileURLToPath(import.meta.url), '../../public');

for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  execFileSync('rsvg-convert', ['-w', size, '-h', size, '-o', join(PUBLIC, name), join(PUBLIC, 'icon.svg')].map(String));
  console.log(`public/${name} ${size}x${size}`);
}
