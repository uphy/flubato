// マイクの生の音をためて、16bit の wav にする。実機で判定を調整するための録音用
export class Recorder {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.chunks = [];
    this.length = 0;
  }

  push(data) {
    this.chunks.push(data);
    this.length += data.length;
  }

  stop() {
    return new Blob([encodeWav(this.chunks, this.length, this.sr)], { type: 'audio/wav' });
  }
}

/**
 * 振り返り用に、弾いている間のマイクの音をためておく（直前の1回ぶん）。
 * start は samples[0] の AudioContext の時刻（秒）。追従器・判定器の時刻と同じ時計
 */
export class Take {
  constructor(sampleRate, maxSec = 600) {
    this.sr = sampleRate;
    this.max = Math.round(maxSec * sampleRate); // これより長い分は捨てる（メモリを食いすぎない）
    this.chunks = [];
    this.length = 0;
    this.start = null;
  }

  push(data, endFrame) {
    if (this.start === null) { this.start = (endFrame - data.length) / this.sr; this.startFrame = endFrame - data.length; }
    if (this.length + data.length > this.max) return;
    this.chunks.push(data);
    this.length += data.length;
  }

  samples() {
    const out = new Float32Array(this.length);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

/**
 * モノラルの wav。ふだんは 16bit。float なら 32bit 浮動小数（マイクの値そのまま。解析し直すと同じ結果になる）。
 * extra（{ id: 4文字, bytes: Uint8Array }）を渡すと data のあとに独自のチャンクとして足す
 * （調査用の情報を埋め込む。ふつうのプレイヤーは知らないチャンクを読み飛ばす）
 */
export function encodeWav(chunks, length, sr, extra = null, float = false) {
  const bps = float ? 4 : 2;
  const extraSize = extra ? 8 + extra.bytes.length + (extra.bytes.length % 2) : 0;
  const buf = new ArrayBuffer(44 + length * bps + extraSize);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + length * bps + extraSize, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, float ? 3 : 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * bps, true); v.setUint16(32, bps, true); v.setUint16(34, bps * 8, true);
  str(36, 'data'); v.setUint32(40, length * bps, true);
  let o = 44;
  for (const c of chunks) {
    if (float) for (let i = 0; i < c.length; i++, o += 4) v.setFloat32(o, c[i], true);
    else for (let i = 0; i < c.length; i++, o += 2) v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767))), true);
  }
  if (extra) {
    str(o, extra.id); v.setUint32(o + 4, extra.bytes.length, true);
    new Uint8Array(buf, o + 8, extra.bytes.length).set(extra.bytes);
  }
  return buf;
}
