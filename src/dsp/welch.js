// Welch法（Hann窓・50%オーバーラップ）によるパワースペクトル密度の逐次計算。
// L+iR を1回の複素FFTにまとめ、L・Rそれぞれのスペクトルとクロススペクトルを同時に得る。
// scipy.signal.welch(window='hann', detrend='constant', scaling='density') と同じ規約。

import { FFT } from './fft.js';

export const DEFAULT_NPERSEG = 32768;

export class WelchAccumulator {
  /**
   * @param {number} fs サンプルレート
   * @param {number} totalFrames 総フレーム数（短い入力で窓長を縮めるために使う）
   */
  constructor(fs, totalFrames, nperseg = DEFAULT_NPERSEG) {
    let n = nperseg;
    while (n > totalFrames && n > 1024) n >>= 1;
    this.disabled = totalFrames < n; // 1024サンプル未満など
    this.fs = fs;
    this.n = n;
    if (this.disabled) return;
    this.fft = new FFT(n);
    this.win = new Float64Array(n);
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      // 周期Hann窓（scipy.signal.get_window('hann') と同じ）
      this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      s2 += this.win[i] * this.win[i];
    }
    this.winPower = s2;
    this.bufL = new Float64Array(n);
    this.bufR = new Float64Array(n);
    this.fill = 0;
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    const bins = (n >> 1) + 1;
    this.accLL = new Float64Array(bins);
    this.accRR = new Float64Array(bins);
    this.accLRre = new Float64Array(bins);
    this.segments = 0;
  }

  push(L, R, count = L.length) {
    if (this.disabled) return;
    const n = this.n;
    let pos = 0;
    while (pos < count) {
      const take = Math.min(n - this.fill, count - pos);
      for (let i = 0; i < take; i++) {
        this.bufL[this.fill + i] = L[pos + i];
        this.bufR[this.fill + i] = R[pos + i];
      }
      this.fill += take;
      pos += take;
      if (this.fill === n) {
        this.#segment();
        const h = n >> 1;
        this.bufL.copyWithin(0, h, n);
        this.bufR.copyWithin(0, h, n);
        this.fill = h;
      }
    }
  }

  #segment() {
    const n = this.n;
    const { bufL, bufR, win, re, im } = this;
    let mL = 0, mR = 0;
    for (let i = 0; i < n; i++) { mL += bufL[i]; mR += bufR[i]; }
    mL /= n;
    mR /= n;
    for (let i = 0; i < n; i++) {
      re[i] = (bufL[i] - mL) * win[i];
      im[i] = (bufR[i] - mR) * win[i];
    }
    this.fft.transform(re, im);
    const half = n >> 1;
    for (let k = 0; k <= half; k++) {
      const j = k === 0 ? 0 : n - k;
      const lre = (re[k] + re[j]) * 0.5;
      const lim = (im[k] - im[j]) * 0.5;
      const rre = (im[k] + im[j]) * 0.5;
      const rim = -(re[k] - re[j]) * 0.5;
      this.accLL[k] += lre * lre + lim * lim;
      this.accRR[k] += rre * rre + rim * rim;
      this.accLRre[k] += lre * rre + lim * rim;
    }
    this.segments++;
  }

  /** 片側PSD（単位²/Hz）。算出不可なら null。 */
  finish() {
    if (this.disabled || this.segments === 0) return null;
    const n = this.n;
    const half = n >> 1;
    const base = 1 / (this.fs * this.winPower * this.segments);
    const pll = new Float64Array(half + 1);
    const prr = new Float64Array(half + 1);
    const plr = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) {
      const scale = k === 0 || k === half ? base : 2 * base; // 片側化
      pll[k] = this.accLL[k] * scale;
      prr[k] = this.accRR[k] * scale;
      plr[k] = this.accLRre[k] * scale;
    }
    return { fs: this.fs, nperseg: n, df: this.fs / n, segments: this.segments, pll, prr, plr };
  }
}
