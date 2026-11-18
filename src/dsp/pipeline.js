// 解析パイプライン: 音声をブロックで受け取り、全指標を1パスで計算する。
// 入力は L, R（モノラルは R===L の同一配列を渡す）。メモリは曲の長さにほぼ依存しない。

import { LoudnessMeter } from './loudness.js';
import { TruePeakMeter } from './truepeak.js';
import { WelchAccumulator } from './welch.js';
import { analyzeSpectrum, sideMinusMidDb } from './bands.js';

export const RESULT_VERSION = 1;
export const SILENCE_DBFS = -60; // これ未満の区間は時間推移から除く
const CLIP_LEVEL = 0.9999;
const GONIO_POINTS = 40000;

const dbAmp = (a) => (a > 0 ? 20 * Math.log10(a) : null);
const dbPow = (p) => (p > 0 ? 10 * Math.log10(p) : null);

export class Analyzer {
  /**
   * @param {{sampleRate:number,totalFrames:number,isMono?:boolean,meta?:object}} o
   */
  constructor({ sampleRate, totalFrames, isMono = false, meta = {} }) {
    if (!(sampleRate > 0)) throw new Error('サンプルレートが不正です');
    this.fs = sampleRate;
    this.totalFrames = totalFrames;
    this.mono = isMono;
    this.meta = meta;

    this.loud = new LoudnessMeter(sampleRate, isMono);
    this.tpL = new TruePeakMeter();
    this.tpR = isMono ? null : new TruePeakMeter();
    this.welch = new WelchAccumulator(sampleRate, totalFrames);

    this.frames = 0;
    this.sL = 0; this.sR = 0; this.sLL = 0; this.sRR = 0; this.sLR = 0;
    this.sMM = 0; this.sSS = 0;
    this.peak = 0;
    this.clip = 0;

    // 0.5秒ごとの窓（相関推移）と、2つ合わせた1秒窓（クレストファクター推移）
    this.half = Math.max(1, Math.round(sampleRate * 0.5));
    this.wn = 0;
    this.wSL = 0; this.wSR = 0; this.wLL = 0; this.wRR = 0; this.wLR = 0; this.wPeak = 0;
    this.corrSeries = [];
    this.crestSeries = [];
    this.oneSq = 0; this.onePeak = 0; this.oneCnt = 0;

    // ゴニオメーター（間引き）
    this.stride = Math.max(1, Math.ceil(totalFrames / GONIO_POINTS));
    this.goniCap = Math.floor(totalFrames / this.stride) + 2;
    this.goni = new Float32Array(this.goniCap * 2);
    this.goniN = 0;
    this.goniWait = 0;
  }

  push(L, R, n = L.length) {
    if (n <= 0) return;
    this.loud.process(L, R, n);
    this.tpL.process(L, n);
    if (this.tpR) this.tpR.process(R, n);
    this.welch.push(L, R, n);

    const mono = this.mono;
    const half = this.half;
    const stride = this.stride;
    const goni = this.goni;
    const INV_SQRT2 = Math.SQRT1_2;
    let { sL, sR, sLL, sRR, sLR, sMM, sSS, peak, clip, wn, wSL, wSR, wLL, wRR, wLR, wPeak, goniN, goniWait } = this;

    for (let i = 0; i < n; i++) {
      const l = L[i];
      const r = R[i];
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      const mx = al > ar ? al : ar;
      if (mx > peak) peak = mx;
      if (mx > wPeak) wPeak = mx;
      if (al >= CLIP_LEVEL) clip++;
      if (!mono && ar >= CLIP_LEVEL) clip++;
      const m = (l + r) * 0.5;
      const s = (l - r) * 0.5;
      sL += l; sR += r; sLL += l * l; sRR += r * r; sLR += l * r;
      sMM += m * m; sSS += s * s;
      wSL += l; wSR += r; wLL += l * l; wRR += r * r; wLR += l * r;

      if (goniWait === 0) {
        if (goniN < this.goniCap) {
          goni[goniN * 2] = (l - r) * INV_SQRT2;
          goni[goniN * 2 + 1] = (l + r) * INV_SQRT2;
          goniN++;
        }
        goniWait = stride;
      }
      goniWait--;

      if (++wn === half) {
        this.#closeWindow(wn, wSL, wSR, wLL, wRR, wLR, wPeak);
        wn = 0; wSL = 0; wSR = 0; wLL = 0; wRR = 0; wLR = 0; wPeak = 0;
      }
    }
    Object.assign(this, { sL, sR, sLL, sRR, sLR, sMM, sSS, peak, clip, wn, wSL, wSR, wLL, wRR, wLR, wPeak, goniN, goniWait });
    this.frames += n;
  }

  #closeWindow(n, sl, sr, ll, rr, lr, peak) {
    const t = (this.corrSeries.length * this.half) / this.fs;
    // 相関（無音窓は除く）
    const rmsDb = dbPow((ll + rr) / (2 * n));
    let corr = null;
    if (rmsDb !== null && rmsDb >= SILENCE_DBFS) {
      const vl = ll - (sl * sl) / n;
      const vr = rr - (sr * sr) / n;
      const cov = lr - (sl * sr) / n;
      const den = Math.sqrt(vl * vr);
      if (den > 1e-20) corr = Math.max(-1, Math.min(1, cov / den));
    }
    this.corrSeries.push({ t, v: corr });

    // 1秒ごとのクレストファクター（0.5秒窓2つ分）
    this.oneSq += ll + rr;
    if (peak > this.onePeak) this.onePeak = peak;
    if (++this.oneCnt === 2) {
      const rms = dbPow(this.oneSq / (2 * 2 * n));
      let crest = null;
      if (rms !== null && rms >= SILENCE_DBFS && this.onePeak > 0) crest = dbAmp(this.onePeak) - rms;
      this.crestSeries.push({ t: t - this.half / this.fs, v: crest });
      this.oneSq = 0; this.onePeak = 0; this.oneCnt = 0;
    }
  }

  finish() {
    const N = this.frames;
    if (N === 0) throw new Error('EMPTY');
    const loud = this.loud.finish();
    let tpLin = this.tpL.finish();
    if (this.tpR) tpLin = Math.max(tpLin, this.tpR.finish());
    tpLin = Math.max(tpLin, this.peak);
    const samplePeakDb = dbAmp(this.peak);
    const truePeakDb = dbAmp(tpLin);

    const rmsDb = dbPow((this.sLL + this.sRR) / (2 * N));
    const crest = rmsDb !== null && samplePeakDb !== null ? samplePeakDb - rmsDb : null;
    const integrated = loud.integrated;
    const plr = truePeakDb !== null && integrated !== null ? truePeakDb - integrated : null;

    const validCrest = this.crestSeries.filter((p) => p.v !== null).map((p) => p.v);
    const crestMean = validCrest.length ? validCrest.reduce((a, b) => a + b, 0) / validCrest.length : null;

    // ステレオ
    const varL = this.sLL - (this.sL * this.sL) / N;
    const varR = this.sRR - (this.sR * this.sR) / N;
    const cov = this.sLR - (this.sL * this.sR) / N;
    const den = Math.sqrt(varL * varR);
    const correlation = den > 1e-20 ? Math.max(-1, Math.min(1, cov / den)) : null;
    const msTotal = this.sMM + this.sSS;
    const sideRatio = msTotal > 0 ? (this.sSS / msTotal) * 100 : null;
    const sideMinusMid = sideMinusMidDb(this.sSS, this.sMM);

    const spec = analyzeSpectrum(this.welch.finish());

    return {
      version: RESULT_VERSION,
      meta: {
        ...this.meta,
        sampleRate: this.fs,
        frames: N,
        duration: N / this.fs,
        isMono: this.mono,
      },
      loudness: {
        integrated,
        lra: loud.lra,
        momentaryMax: loud.momentaryMax,
        shortTermMax: loud.shortTermMax,
        truePeak: truePeakDb,
        samplePeak: samplePeakDb,
        clipSamples: this.clip,
      },
      dynamics: {
        rms: rmsDb,
        crest,
        plr,
        crestMean,
        crestSeries: this.crestSeries,
      },
      spectrum: spec && { nperseg: spec.nperseg, segments: spec.segments, refDb: spec.refDb, bands: spec.bands, seven: spec.seven },
      stereo: {
        correlation,
        sideRatio,
        sideMinusMid,
        lowSideMinusMid: spec ? spec.lowSideMinusMid : null,
        corrSeries: this.corrSeries,
        goniometer: this.goni.slice(0, this.goniN * 2), // [x0,y0,x1,y1,...] x=(L-R)/√2, y=(L+R)/√2
      },
    };
  }
}
