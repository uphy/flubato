// 調査用に保存する情報。録音（wav）に JSON のチャンクとして埋め込み、tools/eval.mjs で動かし直せるようにする。
// 精度が悪かった回を、そのときのアプリの判断・設定・曲ごと持ち帰るためのもの。
import { encodeWav } from './recorder.js';

/* global __BUILD__ */
const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

const round = (x, d = 4) => (x == null ? x : Math.round(x * 10 ** d) / 10 ** d);

/** 練習モード: 追従器がその場でどう判断したか（アタックごとの候補と、動いた位置）と、見直し後の道筋 */
export function practiceDiag(follower, moves, stumbles, review) {
  return {
    kind: 'practice',
    practice: {
      startGroup: follower.startPos + 1,
      opts: follower.o,
      // アタックごとの候補（上位8つ）と、その場で選んだ位置
      events: follower.events.map(e => ({
        t: round(e.t), preT: round(e.preT), postT: round(e.postT), tempo: round(e.tempo, 3),
        cand: [...e.lik].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([q, l]) => [q, round(l, 4)]),
      })),
      moves: moves.map(m => ({ t: round(m.t), pos: m.pos, prev: m.prev, conf: round(m.conf, 3), kind: m.kind })),
      path: follower.path().map(p => ({ t: round(p.t), pos: p.pos })),
      stumbles,
    },
    review: compactReview(review),
  };
}

/** 音ゲーモード: 判定の設定と1音ずつの結果 */
export function gameDiag(judge, range, passMap, review) {
  return {
    kind: 'game',
    game: {
      range, passMap, judgeOpts: judge.o,
      notes: judge.state.map(s => [s.result, round(s.delta)]),
    },
    review: compactReview(review),
  };
}

function compactReview(review) {
  if (!review) return null;
  return review.groups.map((G, g) => ({ g, t: round(G.t), marks: G.marks.map(m => m.kind + ':' + m.text), notes: [...G.notes] }))
    .filter(x => x.marks.length);
}

/**
 * 調査用の wav を作る。common には曲・設定・録音の位置合わせ（takeStart など）、part には practiceDiag / gameDiag の結果
 */
export function diagWav(take, common, part, note) {
  const meta = {
    format: 'flubato-diag', version: 1, build: BUILD, createdAt: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '', note, ...common, ...part,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(meta));
  // 16bit に丸めると解析の値が少し変わり、アタックの位置が1コマずれることがあるので、マイクの値そのまま
  return new Blob([encodeWav(take.chunks, take.length, take.sr, { id: 'flrp', bytes }, true)], { type: 'audio/wav' });
}

/** Uint8Array → base64（曲のファイルを埋め込む） */
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
