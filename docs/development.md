# 開発

依存は Node.js 22 と npm だけ。フレームワークは使わず、素の JavaScript（ES modules）で書いている。

## コマンド

```sh
npm ci
npm run build   # dist/index.html（1枚で完結。これを配信する）と dist/app.js（開発用）
npm start       # http://localhost:8770/ で配る。コードを変えたら npm run build し直して再読み込み
npm test        # 譜面の読み込みと判定（合成したギター音で）
node tools/smoke.mjs out.png   # ヘッドレス Chrome に合成音をマイクとして流して、両モードを通しで遊ぶ
node tools/eval.mjs 調査用.wav [--verbose] [--opts JSON]  # アプリの「調査用に保存」を、同じ曲・設定で動かし直してアプリの判断と比べる
node tools/eval.mjs 曲.gp 録音.wav [--verbose]   # ふつうの録音（「● 録音」など）を追従器に通す
node tools/tex2gp.mjs in.tex [out.gp]           # alphaTex → Guitar Pro
node tools/icons.mjs                            # public/icon.svg から PNG のアイコンを作り直す（rsvg-convert を使う）
```

`tools/smoke.mjs` と `tools/tex2gp.mjs` は Chrome を使う。Mac では `CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` を付ける。

ホーム画面に追加して開くアプリ（PWA）にしてある。manifest・アイコン・`sw.js` は `public/` に置き、`npm run build` が `dist/` にコピーする。`sw.js` は毎回ネットから取り、取れないときだけ手元の控えを出すので、公開した新しい版は次に開いたときに届き、電波がなくても開ける。

マイクは https か localhost でしか使えない。`dist/index.html` を file:// で開いても使える。

## しくみ

- `src/chart.js` — alphaTab で Guitar Pro 3〜8 / MusicXML を読み、繰り返し・テンポ変化・タイ・カポを反映して「何秒目に何弦の何フレット」の譜面にする
- `src/dsp.js` / `src/judge.js` — 耳コピはしない。譜面が「弾くはず」と言っている音について、その高さの成分が判定の窓の中で立ち上がったかだけを見る
  - 倍音の和（salience）＋ 基音か2倍音が本当に山になっているか（`lowPeak`）で、開放の1・2弦を6弦Eの倍音と取り違えない
  - 鳴らしっぱなしの弦を弾き直したときは成分がほとんど増えないので、アタック（flux）と重なっていれば良しとする
- `src/follow.js` — 練習モードの追従。アタックごとに「どの和音を弾いたか」を確率で選び直し（音と間隔が手がかり）、終わってから全体を見直す（Viterbi）
- `src/flex.js` — 音ゲーモードの「テンポを合わせる」。追従器の位置とテンポから、曲の時計の進み方を決める。時計と実時間の対応は `src/clock.js`
- `src/view.js` — 音ゲーモードの画面。タブ譜と同じ向き（上が1弦）のレーン
- `src/tuner.js` — チューナー。鳴っている1つの音の高さを McLeod の方法（NSDF）で測る。判定（`src/dsp.js`）とは別に動く
- `src/sheet.js` — 練習モードの画面。譜めくり型。振り返りもこの画面に重ねる
- `src/demo.js` — 練習モードの「再生」。譜面の音を Karplus-Strong（弦を弾いた音の合成）で鳴らす。音源のファイルは持たない
- `src/review.js` — 振り返りの中身。追従器の見直し後の道筋（音ゲーは判定）から和音ごとの問題を出し、録音を解析し直して聞き取れなかった音を出す
- `test/perform.mjs` — 人っぽい演奏（テンポの揺れ・止まる・飛ばす・間違える・弾き直す・部屋の響き）の合成

## 精度の調査

結果の画面か振り返りの「調査用に保存」で、1つの wav に次を入れて保存する。

- 録音（32bit のまま。アプリと同じ窓で解析し直せるよう、マイクの直前の音と解析の刻みの位置も）
- 曲のファイルそのもの、トラック、設定（マイクの遅れ・判定の厳しさ・速さ・マイク）、アプリの版、ひとこと（何が起きたか）
- 練習モード: アタックごとの候補と尤度、その場で動いた位置、見直し後の道筋、つっかえ、振り返りの印
- 音ゲーモード: 判定の設定、1音ずつの結果とずれ、曲の時刻の対応

`node tools/eval.mjs その.wav --verbose` で、いまのコードで動かし直した結果とアプリの判断の違いが出る。`--opts '{"pLocal":0.02}'` で設定を変えて試せる。

判定・追従の数値は、ほとんど合成音で合わせている。実物のアコギと部屋のマイクでの調整は、アプリの「● 録音」と `tools/eval.mjs` を使って進めている。

## 変更の進め方と公開

- main への push で、GitHub Actions（`.github/workflows/deploy.yml`）がテストしてから Cloudflare Workers の静的配信（`wrangler.jsonc`）に上げる。本番は https://flubato.uphy.dev
- PR を開くと、CI（`.github/workflows/ci.yml`）がテストとビルドを回し、PR 専用の Worker `flubato-pr-<番号>` に上げて、その URL を PR にコメントする。スマホやギターの前の端末で実際に弾いて確かめられる
  - fork からの PR では Cloudflare の鍵が渡らないので、プレビューは立たない
  - PR を閉じると `.github/workflows/preview-cleanup.yml` がその Worker を消す
- Actions のシークレットに `CLOUDFLARE_API_TOKEN`（Workers を編集できる権限）と `CLOUDFLARE_ACCOUNT_ID` が要る
