// 音ゲーモードの曲の時計と、AudioContext の時刻の対応。
// ふつうは始めたときの時刻から速さで一定に進むので、始点と速さだけで決まる。
// テンポを合わせるときは進み方が一定でないので、描画の刻みごとの対応（points: [[ctx, song], ...]）を残して、その間を線でつなぐ。
// m: { ctx0, song0, speed, points? }

/** AudioContext の時刻 → 曲の時刻 */
export function ctxToSong(m, ctx) {
  const p = m.points;
  if (!p?.length) return m.song0 + (ctx - m.ctx0) * m.speed;
  const last = p[p.length - 1];
  if (ctx >= last[0]) return last[1] + (ctx - last[0]) * m.speed;
  if (ctx <= p[0][0]) return p[0][1] - (p[0][0] - ctx) * m.speed;
  let lo = 0, hi = p.length - 1; // p[lo][0] <= ctx < p[hi][0]
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p[mid][0] <= ctx) lo = mid; else hi = mid;
  }
  const [a, sa] = p[lo], [b, sb] = p[hi];
  return sa + (sb - sa) * ((ctx - a) / (b - a || 1));
}

/** 曲の時刻 → AudioContext の時刻（その時刻に最初に届いたとき） */
export function songToCtx(m, t) {
  const p = m.points;
  if (!p?.length) return m.ctx0 + (t - m.song0) / m.speed;
  if (t <= p[0][1]) return p[0][0] - (p[0][1] - t) / m.speed;
  for (let i = 1; i < p.length; i++) {
    const [a, sa] = p[i - 1], [b, sb] = p[i];
    if (sb >= t) return a + (b - a) * ((t - sa) / (sb - sa || 1));
  }
  const last = p[p.length - 1];
  return last[0] + (t - last[1]) / m.speed;
}
