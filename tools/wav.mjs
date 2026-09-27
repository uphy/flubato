// wav を読んでモノラルの Float32Array にする（PCM 16/24/32bit と float32）
import fs from 'node:fs';

export function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`wav ではありません: ${file}`);
  let off = 12, fmt = null, data = null, meta = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(off + 8), channels: b.readUInt16LE(off + 10), sampleRate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') data = { start: off + 8, size: Math.min(size, b.length - off - 8) };
    if (id === 'flrp') meta = JSON.parse(b.toString('utf8', off + 8, off + 8 + size)); // アプリの「調査用に保存」が埋め込む情報
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('fmt / data チャンクが見つかりません');
  const bytes = fmt.bits / 8, frames = Math.floor(data.size / (bytes * fmt.channels));
  const isFloat = fmt.format === 3 || (fmt.format === 0xfffe && fmt.bits === 32 && false);
  const read = o => {
    if (isFloat) return b.readFloatLE(o);
    if (fmt.bits === 16) return b.readInt16LE(o) / 32768;
    if (fmt.bits === 24) return b.readIntLE(o, 3) / 8388608;
    if (fmt.bits === 32) return b.readInt32LE(o) / 2147483648;
    throw new Error(`${fmt.bits}bit には未対応`);
  };
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let v = 0;
    for (let c = 0; c < fmt.channels; c++) v += read(data.start + (i * fmt.channels + c) * bytes);
    out[i] = v / fmt.channels;
  }
  return { samples: out, sampleRate: fmt.sampleRate, meta };
}
