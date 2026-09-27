// マイク入力。AudioWorklet で生の波形を受け取り、HOP ごとに解析してコールバックに渡す。
import { Spectrum, WINDOW, HOP } from './dsp.js';

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage({ end: currentFrame + ch.length, data: ch.slice() });
    return true;
  }
}
registerProcessor('flubato-tap', Tap);
`;

const loaded = new WeakMap(); // AudioContext → worklet を読み込んだ Promise（同じ名前を2回登録しない）

export class Mic {
  constructor(ctx) {
    this.ctx = ctx;
    this.spec = new Spectrum(ctx.sampleRate);
    this.ring = new Float32Array(WINDOW * 2);
    this.filled = 0; // ring に入っている有効サンプル数
    this.sinceHop = 0;
    this.lastEnd = 0;
    this.level = 0; // 表示用の音量（0〜1）
    this.lastFrameEnd = 0; // 最後に解析した窓の終わり（AudioContext のフレーム）
    this.hopPhase = null; // 解析の窓の終わりは、最初のサンプルのフレームから HOP 刻み。その HOP で割った余り
    this.onFrame = null; // (centerCtxTime, spec, flux) => void
    this.onSamples = null; // (data, endFrame) => void 生の波形（録音・振り返り用）。endFrame は data の直後の AudioContext のフレーム
    this.onEnded = null; // マイクが外れた・止められたとき
    this.label = ''; // 使っているマイクの名前
  }

  async start(deviceId) {
    if (!loaded.has(this.ctx)) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      loaded.set(this.ctx, this.ctx.audioWorklet.addModule(url));
    }
    await loaded.get(this.ctx);
    // Chrome は deviceId を指定しないと、既定のマイクではなく下の条件に「よく合う」マイクを選ぶことがある
    // （Mac の既定が内蔵マイクでも、BlackHole などの仮想デバイスが選ばれる）。既定を名指しする
    const hasDefault = async () => (await Mic.devices()).some(d => d.deviceId === 'default');
    const open = id => navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: id ? { exact: id } : undefined,
        // ギターを拾うので、声向けの加工は全部切る
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    if (!deviceId && await hasDefault()) deviceId = 'default';
    this.stream = await open(deviceId);
    if (!deviceId && await hasDefault()) {
      // 初めて許可をもらったときは、許可の前は一覧に既定が出てこない。許可のあとで既定を開き直す
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = await open('default');
    }
    const track = this.stream.getAudioTracks()[0];
    this.label = track?.label ?? '';
    if (track) track.onended = () => this.onEnded?.();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'flubato-tap');
    this.node.port.onmessage = e => this._push(e.data);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.source.connect(this.node).connect(mute).connect(this.ctx.destination);
  }

  stop() {
    this.stream?.getTracks().forEach(t => { t.onended = null; t.stop(); });
    this.node?.disconnect();
    this.source?.disconnect();
  }

  _push({ end, data }) {
    if (this.hopPhase === null) this.hopPhase = (((end - data.length) % HOP) + HOP) % HOP;
    this.onSamples?.(data, end);
    const r = this.ring;
    // 古いものを詰めて末尾に足す
    if (this.filled + data.length > r.length) {
      const keep = r.length - data.length;
      r.copyWithin(0, this.filled - keep, this.filled);
      this.filled = keep;
    }
    r.set(data, this.filled);
    this.filled += data.length;
    this.lastEnd = end;
    this.sinceHop += data.length;
    while (this.sinceHop >= HOP) {
      this.sinceHop -= HOP;
      const stop = this.filled - this.sinceHop;
      if (stop < WINDOW) continue;
      const { flux, rms } = this.spec.analyze(r.subarray(stop - WINDOW, stop));
      this.level = Math.max(rms * 4, this.level * 0.9);
      const endFrame = this.lastEnd - this.sinceHop;
      this.lastFrameEnd = endFrame;
      const center = (endFrame - WINDOW / 2) / this.ctx.sampleRate;
      this.onFrame?.(center, this.spec, flux);
    }
  }

  /**
   * 直前の WINDOW + HOP サンプルと、その直後のフレーム。録音をここから始めると、次の解析の窓と、
   * その flux の比べ先（1つ前の窓）がまるごと録音に入る（調査用の録音をアプリと同じ窓で解析し直せる）
   */
  recent() {
    const n = Math.min(WINDOW + HOP, this.filled);
    return { data: this.ring.slice(this.filled - n, this.filled), end: this.lastEnd };
  }

  static async devices() {
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.filter(d => d.kind === 'audioinput');
  }
}
