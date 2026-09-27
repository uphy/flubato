// 練習モードの本体。人の演奏に譜面がついていく（楽譜追従）。
//
// 時計は使わない。アタックが来るたびに「いま譜面のどの和音（group）を弾いたか」を確率で選び直す。
//   - 次へ進むのがいちばんありそう。1〜2個飛ばす・同じところを弾き直す・小節の頭に戻る、も起こりうる
//   - どれがそれらしいかは、その group の音がアタックの前後で立ち上がったか（答え合わせ）で決める
// 1音ずつの判定がそこそこ外れても、並びで見ると位置は崩れにくい。和音を全部拾えなくてもいい。

import { OnsetDetector, midiToHz as midiHz } from './dsp.js';

export const FOLLOW_DEFAULTS = {
  presentDb: 14,
  lowPeakDb: 10,
  riseDb: 3, // アタックの前後でこれだけ増えていれば「いま弾いた」
  legatoRiseDb: 8, // アタックなし（ハンマリング等）で進むときの立ち上がり
  strayMatch: 0.25,
  onBeatTol: 0.45, // 次の和音の間合いとのずれ（対数）。これ以内なら、音が合わなくても進める
  matchFloor: 0.01, // まったく合わない候補にも残す可能性（小さいほど音の証拠を重く見る） // どの候補もこれ未満なら、雑音か間違いとして位置を動かさない
  mergeSec: 0.12, // これより近いアタックは同じ1回とみなす（アタックの時刻は窓の中心なので、実際の間隔は 0.1 秒弱まで）
  preFrames: 3, // アタックの何フレーム前を「前」とするか
  postFrames: 5, // 何フレーム後を「後」とするか
  // 遷移の重み（正規化前）
  pNext: 0.62, pSkip1: 0.1, pSkip2: 0.03, pStay: 0.08, pBarStart: 0.06, pPrevBarStart: 0.04, pLocal: 0.01,
  localSpan: 16,
  timeSigma: 0.45, // 間隔のずれをどこまで許すか（対数）
  timedBackLik: 0.03, // 流れの途中（間を空けずに）戻る。弾き直しは、たいてい少し間を空けてからする
  timedBarBackLik: 0.03,
  breakRatio: 2.2,
  echoRatio: 0.5, // 次の音までの間隔のこれ未満で来たアタックは、同じ音を二重に拾ったものかもしれない
  hesitateSec: 1.0, // 少なくともこれだけ間が空いたら「止まった」
  hesitateRatio: 2.5, // 譜面上の間隔×いまのテンポ比のこれ倍
};

export class Follower {
  constructor(chart, opts = {}) {
    this.chart = chart;
    this.o = { ...FOLLOW_DEFAULTS, ...opts };
    this.G = chart.groups.length;
    // group ごとの小節の頭の group
    this.barStart = new Int32Array(this.G);
    this.prevBarStart = new Int32Array(this.G);
    const firstOfBar = new Map();
    chart.groups.forEach((g, i) => { if (!firstOfBar.has(g.bar)) firstOfBar.set(g.bar, i); });
    const barFirsts = [...firstOfBar.values()].sort((a, b) => a - b);
    chart.groups.forEach((g, i) => {
      this.barStart[i] = firstOfBar.get(g.bar);
      const k = barFirsts.indexOf(this.barStart[i]);
      this.prevBarStart[i] = barFirsts[Math.max(0, k - 1)];
    });
    // 重み: いちばん上の音（メロディ）とベースを重く
    this.weights = chart.groups.map(g => {
      const midis = g.noteIds.map(id => chart.notes[id].midi);
      const hi = Math.max(...midis), lo = Math.min(...midis);
      return g.noteIds.map(id => {
        const m = chart.notes[id].midi;
        return m === hi ? 1.5 : m === lo && g.noteIds.length > 1 ? 1.2 : 1;
      });
    });
    // 響く部屋ではアタックが鈍る。追従では取りこぼしのほうが困るので、判定より低めのしきい値
    this.onsets = new OnsetDetector({ refractory: 0.08, minFlux: 1.2, ratio: 1.8 });
    this.start(0);
  }

  /** from 番目の group から弾き始める */
  start(fromGroup = 0) {
    this.belief = new Map([[fromGroup - 1, 1]]); // 位置 = 最後に弾いた group（-1 はまだ何も）
    this.entered = new Map(); // 位置ごとの、その group に入った時刻（間隔はここから測る）
    this.pos = fromGroup - 1;
    this.conf = 1;
    this.ring = []; // 直近のスペクトルの控え { t, snap }
    this.pending = null;
    this.lastOnsetT = null;
    this.onsets.reset();
    this.lastEventT = null;
    this.enteredT = null;
    this.tempo = 1; // 実際の間隔 / 譜面上の間隔
    this.played = new Uint8Array(this.G); // 1: 弾いた 2: 飛ばした
    this.events = []; // 位置を動かしたアタック { t, preT, postT, tempo, lik }（あとで道筋を見直す用）
    this.startPos = fromGroup - 1;
    this.frame = 0;
  }

  /**
   * 1フレーム進める。t は秒（何の時計でもよい。間隔だけ使う）。
   * 位置が動いたら { t, pos, prev, conf, kind } を返す。
   */
  step(t, spec, flux) {
    this.frame++;
    this.ring.push({ t, snap: spec.snapshot() });
    if (this.ring.length > 14) this.ring.shift();
    const onset = this.onsets.push(t, flux);
    const o = this.o;

    // 指で弾くと、指が弦に触れた音と弦を離した音で、0.1秒以内に山が2つ立つことが多い。1回のアタックにまとめ、
    // 答え合わせはあとの山を過ぎてからにする（先の山のすぐあとでは、まだ弦が鳴り出していない）
    // （あとの山は検出器の不応期に入ってアタックとして拾えないことが多いので、窓の中でいちばん大きい山から数える）
    if (this.pending && t - this.pending.t < o.mergeSec) {
      // 山が続くうちは、答え合わせをそのあとへずらす（先の山のほうが大きく見えることもあるので、低めの割合で見る）
      if (flux > this.pending.peak * 0.2) this.pending.due = Math.max(this.pending.due, this.frame + o.postFrames);
      this.pending.peak = Math.max(this.pending.peak, flux);
    } else if (onset && this.lastOnsetT !== null && t - this.lastOnsetT < o.mergeSec) { /* 答え合わせ済みのアタックの続き */ }
    else if (onset && !this.pending && this.ring.length > o.preFrames) {
      const before = this.ring[this.ring.length - 1 - o.preFrames];
      this.pending = { t, peak: flux, pre: before.snap, preT: before.t, due: this.frame + o.postFrames };
      this.lastOnsetT = t;
    }
    if (this.pending && this.frame >= this.pending.due) {
      const { t: t0, pre, preT } = this.pending;
      this.pending = null;
      return this._event(t0, spec, pre, 'onset', preT, t);
    }
    // アタックのない音（ハンマリング・プリング・スライド）は、次の group の音の立ち上がりだけで進める
    if (!this.pending && this.ring.length >= 12 && (this.lastEventT === null || t - this.lastEventT > 0.1)) {
      const next = this.pos + 1;
      if (next < this.G && this.chart.groups[next].noteIds.some(id => this.chart.notes[id].kind === 'legato')) {
        const pre = this.ring[0].snap;
        this._memo = new Map();
        if (this._match(next, spec, pre, o.legatoRiseDb, false) >= 0.5) return this._event(t, spec, pre, 'legato', this.ring[0].t, t);
      }
    }
    return null;
  }

  /** group g が「いま弾かれた」らしさ 0〜1 */
  _match(g, spec, pre, riseDb, allowRinging = true) {
    const w = this.weights[g];
    const scores = this._noteScores(g, spec, pre, riseDb, allowRinging);
    let sum = 0, wsum = 0;
    scores.forEach((v, k) => { sum += w[k] * v; wsum += w[k]; });
    return wsum ? sum / wsum : 0;
  }

  /**
   * group g の音ごとの「いま弾かれた」らしさ（noteIds の順）。振り返りで、どの音が聞こえなかったかを出すのにも使う。
   * pre はアタックの前、spec はあとのスペクトル
   */
  noteScores(g, spec, pre) {
    this._memo = new Map();
    return this._noteScores(g, spec, pre, this.o.riseDb, true);
  }

  _noteScores(g, spec, pre, riseDb, allowRinging) {
    const o = this.o;
    const floor = spec.noiseFloor();
    const preFloor = spec.withSnapshot(pre, () => spec.noiseFloor());
    return this.chart.groups[g].noteIds.map(id => {
      const n = this.chart.notes[id];
      if (n.kind === 'dead') return 0.5; // アタックがあったことしか分からない
      const sal = this._cache(spec, 'post', n.midi, () => spec.salience(n.midi));
      if (sal - floor < o.presentDb) return 0;
      // 基音か2倍音の山。ほかの弦がたくさん鳴っていると谷が埋まって低めに出るので、少し足りないくらいは半分で認める
      // 高めの音を2倍音だけで認めると、5度下の音の3倍音と重なって取り違える（A3 を弾くと E4 に見える）。
      // 基音の山があれば満点、2倍音だけなら控えめに
      let sure = 1;
      if (n.kind !== 'harmonic') {
        const lp1 = this._cache(spec, 'lp1', n.midi, () => spec.lowPeak(n.midi, 1));
        const lp2 = this._cache(spec, 'lp2', n.midi, () => spec.lowPeak(n.midi, 2));
        const grade = lp => (lp >= o.lowPeakDb ? 1 : lp >= o.lowPeakDb - 5 ? 0.6 : 0);
        sure = Math.max(grade(lp1), grade(lp2) * (midiHz(n.midi) < 150 ? 1 : 0.5));
      }
      if (!sure) return 0;
      const before = this._cache(spec, 'pre', n.midi, () => spec.withSnapshot(pre, () => spec.salience(n.midi)));
      // 立ち上がりは、その音の基音の山そのものが大きくなったかで見る。倍音の合計だと、
      // 別の音の高い倍音がたまたま重なって増えたぶんまで拾ってしまう
      const fRise = this._cache(spec, 'f', n.midi, () => spec.fundamental(n.midi)) -
        this._cache(spec, 'fpre', n.midi, () => spec.withSnapshot(pre, () => spec.fundamental(n.midi)));
      if (fRise >= riseDb && sal - before >= 0) {
        // 1オクターブ下の音を弾いても、その倍音でこの音が立ち上がって見える（3弦開放G → 1弦3フレットG）。
        // 下の音の奇数倍音も一緒に立ち上がっていたら、下の音のせいかもしれないので半分にする
        // 下の音は基音そのもの（2倍音はこの音と同じ所なので見ない）
        const sub = n.midi - 12;
        const subPeak = () => Math.log10(spec.peakAround(midiHz(sub), 35) + 1e-9) * 20;
        const subRise = this._cache(spec, 'sub', sub, subPeak) - this._cache(spec, 'subpre', sub, () => spec.withSnapshot(pre, subPeak));
        const subThere = this._cache(spec, 'lp1', sub, () => spec.lowPeak(sub, 1)) >= o.lowPeakDb;
        return sure * (subThere && subRise >= riseDb ? 0.5 : 1);
      }
      if (allowRinging && before - preFloor >= o.presentDb && this._ringing(spec, pre, n.midi)) return sure * 0.6; // 鳴っていた弦の弾き直しかもしれない
      return sure * 0.3; // 鳴ってはいる
    });
  }

  /** アタックの前から、その音が本当に鳴っていたか（基音の山があったか） */
  _ringing(spec, pre, midi) {
    return this._cache(spec, 'ring', midi, () => spec.withSnapshot(pre, () =>
      Math.max(spec.lowPeak(midi, 1), midiHz(midi) < 150 ? spec.lowPeak(midi, 2) : -Infinity))) >= this.o.lowPeakDb - 5;
  }

  _cache(spec, kind, midi, fn) {
    const key = kind + midi;
    if (this._memo.has(key)) return this._memo.get(key);
    const v = fn();
    this._memo.set(key, v);
    return v;
  }

  /**
   * p（最後に弾いた group）から次にどこを弾くかの候補と重み。
   * 前の音からの間隔も手がかりにする。同じ音型がくり返す曲（アルペジオ）では、音だけでは
   * どの拍か決まらないが、「3つ先に飛んだにしては早すぎる」は分かる。
   */
  _targets(p, gap, tempo) {
    const o = this.o, groups = this.chart.groups, G = this.G;
    // gap は「p の group に入ってから」の時間。同じところに留まったアタック（二重に拾ったアタック・
    // 鳴らしっぱなしの弦のにごり）から測ると、次の本物の音が早すぎるように見えて迷子になる
    // 次の音までの譜面上の間隔よりずっと長く空いたら、流れが切れた（止まった・戻るつもり）とみて間隔は使わない
    const p0 = Math.max(0, p), p1 = Math.min(G - 1, p + 1);
    const expectedNext = Math.max(0.05, (groups[p1].t - groups[p0].t) * tempo);
    const timed = gap !== null && p >= 0 && gap < o.hesitateSec * 1.5 && gap < o.breakRatio * expectedNext;
    const out = new Map();
    const add = (q, v) => {
      if (q < 0 || q >= G) return;
      let lik = 1;
      if (timed) {
        // 流れの途中で間を空けずに戻る・同じところをもう一度、は起こりにくい。
        // 似た音型がくり返す曲では、ここを甘くすると前の小節へ吸い寄せられる
        // 同じところのまま、は「次の音にしては早すぎる」ときにありそう（アタックを二重に拾った）
        // 最後の和音のあとは次がないので、鳴らし直しても留まる
        if (q === p) lik = p === G - 1 || gap < o.echoRatio * expectedNext ? 1 : o.timedBackLik;
        else if (q < p) lik = this.barStart[q] === q ? o.timedBarBackLik : o.timedBackLik;
        else {
          const lr = Math.log(gap / Math.max(0.04, (groups[q].t - groups[p].t) * tempo));
          lik = Math.exp(-(lr * lr) / (2 * o.timeSigma * o.timeSigma));
        }
      }
      out.set(q, (out.get(q) || 0) + v * lik);
    };
    add(p + 1 < G ? p + 1 : p, o.pNext); // 弾き終わったら、次へ進むぶんは留まるへ
    add(p + 2, o.pSkip1);
    add(p + 3, o.pSkip2);
    add(p, o.pStay);
    const nb = Math.min(G - 1, p + 1);
    add(this.barStart[nb], o.pBarStart);
    add(this.prevBarStart[nb], o.pPrevBarStart);
    const lo = Math.max(0, p - o.localSpan), hi = Math.min(G - 1, p + o.localSpan);
    for (let q = lo; q <= hi; q++) add(q, o.pLocal / (hi - lo + 1));
    return out;
  }

  _event(t, spec, pre, source, preT, postT) {
    const o = this.o;
    this._memo = new Map();
    // 事前分布（遷移）。q に入った時刻は、いちばん効いた p から引き継ぐ（留まるなら p に入った時刻のまま）
    const prior = new Map(), from = new Map();
    for (const [p, b] of this.belief) {
      if (b < 1e-4) continue;
      const since = this.entered.get(p) ?? null;
      for (const [q, w] of this._targets(p, since === null ? null : t - since, this.tempo)) {
        const v = b * w;
        prior.set(q, (prior.get(q) || 0) + v);
        if (!from.has(q) || v > from.get(q).v) from.set(q, { v, entered: q === p ? since : t });
      }
    }
    // 尤度
    const post = new Map();
    const lik = new Map();
    let total = 0, bestMatch = 0;
    for (const [q, pr] of prior) {
      if (pr < 1e-5) continue;
      const m = this._match(q, spec, pre, source === 'legato' ? o.legatoRiseDb : o.riseDb);
      if (pr > 0.01 && m > bestMatch) bestMatch = m;
      const l = o.matchFloor + m * m;
      lik.set(q, l);
      const v = pr * l;
      post.set(q, v);
      total += v;
    }
    // それらしい候補がない＝雑音・間違い。ただし次の和音のちょうどの間合いで来たなら、弾いたが音を拾えなかった
    // （低音域では半音が解析の刻みより狭い）とみて進める。捨てると1音ずつ遅れていく
    if (total === 0 || (bestMatch < o.strayMatch && !this._onBeat(t))) return null;
    // あとで道筋を見直せるように控えておく
    // preT / postT は答え合わせに使った前後のスペクトルの時刻（振り返りで録音から同じ所を解析し直す）
    this.events.push({ t, preT, postT, tempo: this.tempo, lik });

    let pos = this.pos, best = -1;
    this.belief = new Map();
    this.entered = new Map();
    for (const [q, v] of post) {
      const pv = v / total;
      if (pv > 1e-4) { this.belief.set(q, pv); this.entered.set(q, from.get(q).entered); }
      if (pv > best) { best = pv; pos = q; }
    }
    return this._moved(t, pos, best);
  }

  /** いまの位置から見て、t が次の和音のちょうどの間合いか */
  _onBeat(t) {
    const p = this.pos, groups = this.chart.groups;
    if (p < 0 || p + 1 >= this.G || this.enteredT == null) return false;
    const gap = t - this.enteredT;
    const expected = Math.max(0.05, (groups[p + 1].t - groups[p].t) * this.tempo);
    return gap < this.o.hesitateSec && Math.abs(Math.log(gap / expected)) < this.o.onBeatTol;
  }

  _moved(t, pos, conf) {
    const o = this.o;
    const prev = this.pos;
    const groups = this.chart.groups;
    if (this.enteredT != null && prev >= 0 && pos === prev + 1) {
      const gap = t - this.enteredT;
      const scoreGap = Math.max(0.05, groups[pos].t - groups[prev].t);
      if (gap < o.hesitateSec) this.tempo = this.tempo * 0.8 + Math.min(4, Math.max(0.25, gap / scoreGap)) * 0.2;
    }
    if (pos > prev + 1) for (let g = prev + 1; g < pos; g++) if (!this.played[g]) this.played[g] = 2;
    if (pos < prev) for (let g = pos; g <= prev; g++) this.played[g] = 0;
    this.played[pos] = 1;
    this.pos = pos;
    this.conf = conf;
    this.lastEventT = t;
    if (pos !== prev || this.enteredT == null) this.enteredT = t;
    const kind = pos === prev + 1 ? 'next' : pos === prev ? 'stay' : pos > prev ? 'skip' : 'back';
    return { t, pos, prev, conf, kind };
  }

  /**
   * 弾き終わってから、全体を見て一番筋の通る道筋を選び直す（Viterbi）。
   * 弾いている最中はその場の推定しかできず、弾き直しの直後などに数音だけ迷子になることがある。
   * あとから見れば「そのあとこう続いた」が分かるので、迷子をつっかえと取り違えない
   */
  path() {
    let V = new Map([[this.startPos, 0]]);
    let entered = new Map(); // 道筋ごとの、いまの group に入った時刻
    const backs = [];
    for (const ev of this.events) {
      const nv = new Map(), bp = new Map(), ne = new Map();
      for (const [p, vp] of V) {
        const since = entered.get(p) ?? null;
        for (const [q, w] of this._targets(p, since === null ? null : ev.t - since, ev.tempo)) {
          const l = ev.lik.get(q);
          if (l === undefined) continue;
          const sc = vp + Math.log(w) + Math.log(l);
          if (!nv.has(q) || sc > nv.get(q)) { nv.set(q, sc); bp.set(q, p); ne.set(q, q === p ? since : ev.t); }
        }
      }
      if (nv.size === 0) { backs.push(null); continue; } // つながらない（まれ）: そのフレームは飛ばす
      // 上位だけ残す
      V = new Map([...nv].sort((a, b) => b[1] - a[1]).slice(0, 200));
      entered = ne;
      backs.push(bp);
    }
    let q = [...V].sort((a, b) => b[1] - a[1])[0]?.[0] ?? this.startPos;
    const path = new Array(this.events.length);
    for (let i = this.events.length - 1; i >= 0; i--) {
      path[i] = q;
      if (backs[i]) q = backs[i].get(q) ?? q;
    }
    return path.map((pos, i) => ({ t: this.events[i].t, pos }));
  }

  /** 見直し後の道筋で、弾いた（1）・飛ばした（2）を付け直す */
  playedFromPath() {
    const pl = new Uint8Array(this.G);
    let prev = this.startPos;
    for (const { pos } of this.path()) {
      for (let g = prev + 1; g < pos; g++) if (!pl[g]) pl[g] = 2;
      pl[pos] = 1;
      prev = pos;
    }
    return pl;
  }

  /** 小節（chart.bars の添字）ごとのつっかえ { bar, hesitate, back, skip, score } を多い順に */
  stumbles() {
    const o = this.o, groups = this.chart.groups;
    const barOf = g => groups[Math.max(0, g)].bar;
    const m = new Map();
    const bump = (bar, kind, n = 1) => {
      const s = m.get(bar) || { bar, hesitate: 0, back: 0, skip: 0 };
      s[kind] += n;
      m.set(bar, s);
    };
    let prev = this.startPos, lastT = null, tempo = 1;
    for (const { t, pos } of this.path()) {
      const gap = lastT === null ? null : t - lastT;
      if (gap !== null && prev >= 0) {
        const scoreGap = Math.max(0.05, groups[Math.min(this.G - 1, prev + 1)].t - groups[prev].t);
        if (pos === prev + 1 && gap < o.hesitateSec) tempo = tempo * 0.8 + Math.min(4, Math.max(0.25, gap / scoreGap)) * 0.2;
        if (pos >= prev && gap > Math.max(o.hesitateSec, o.hesitateRatio * scoreGap * tempo)) bump(barOf(pos), 'hesitate');
      }
      if (pos > prev + 1) bump(barOf(prev + 1), 'skip', pos - prev - 1);
      if (pos < prev) bump(barOf(pos), 'back');
      prev = pos; lastT = t;
    }
    return [...m.values()]
      .map(s => ({ ...s, score: s.hesitate + s.back * 2 + s.skip }))
      .sort((a, b) => b.score - a.score || a.bar - b.bar);
  }
}

