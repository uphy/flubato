// dist/app.js（開発用）と dist/index.html（1枚で完結する配布用）を作る
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

// 調査用に保存したファイルに、どの版のアプリで弾いたかを残す
const sh = cmd => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
// CI の PR では checkout がマージコミットなので、PR の先頭の commit を BUILD_COMMIT で渡す
const commit = process.env.BUILD_COMMIT?.slice(0, 7) || sh('git rev-parse --short HEAD') || 'unknown';
const build = `${commit}${!process.env.BUILD_COMMIT && sh('git status --porcelain') ? '+dirty' : ''} ${new Date().toISOString().slice(0, 16)}`;

await esbuild.build({
  entryPoints: ['src/app.js'],
  bundle: true,
  format: 'esm',
  target: ['chrome110', 'safari16', 'firefox115'],
  minify: true,
  outfile: 'dist/app.js',
  loader: { '.gp': 'binary' },
  define: { __BUILD__: JSON.stringify(build) },
  logLevel: 'warning',
});
const js = fs.readFileSync('dist/app.js', 'utf8').replace(/<\/script/gi, '<\\/script');
const html = fs.readFileSync('index.html', 'utf8')
  .replace('<script type="module" src="./dist/app.js"></script>', () => `<script type="module">${js}</script>`);
fs.writeFileSync('dist/index.html', html);
// PWA にするための manifest・アイコン・service worker を横に並べる
fs.cpSync('public', 'dist', { recursive: true });
// Cloudflare に上げるのは1枚で完結する index.html だけ。開発用の app.js は配信しない
fs.writeFileSync('dist/.assetsignore', 'app.js\n');
console.log('dist/index.html', (fs.statSync('dist/index.html').size / 1024).toFixed(0), 'KB');
