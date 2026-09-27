// PR ごとのプレビュー用に wrangler の設定を作り直す。
// Worker 名を flubato-pr-<番号> に変え、本番のカスタムドメインへは載せない。
// 出来上がる .wrangler-preview.json は workers.dev のサブドメインで配信される。
import { readFileSync, writeFileSync } from 'node:fs';

const pr = process.env.PR_NUMBER;
if (!/^\d+$/.test(pr ?? '')) throw new Error('PR_NUMBER が要る');

// wrangler.jsonc はコメントを含めていないので、そのまま JSON として読める
const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
config.name = `flubato-pr-${pr}`;
delete config.routes;

writeFileSync('.wrangler-preview.json', JSON.stringify(config, null, 2) + '\n');
