// ITU-R BS.1770-4 / EBU R128 ラウドネス（積算・モーメンタリ・ショートターム・LRA）。
// ブロック処理: 100msのサブブロックごとにK特性後の二乗和だけを保持する。
// 400ms / 3s のブロックはサブブロックの和で作る（ホップ100ms）。メモリは100msあたり16バイト。

import { kWeightCoefficients } from './kfilter.js';

const OFFSET = -0.691;

export function energyToLufs(e) {
  return e > 0 ? OFFSET + 10 * Math.log10(e) : -Infinity;
}
function lufsToEnergy(l) {
  return Math.pow(10, (l - OFFSET) / 10);
}

export class LoudnessMeter {
  /** mono=true のときは R を L と同一として扱い、片側だけ計算する。 */
  constructor(fs, mono = false) {
    this.fs = fs;
    this.mono = mono;
    this.sub = Math.max(1, Math.round(fs * 0.1)); // 100msのサンプル数
    const c = kWeightCoefficients(fs);
    this.c = c;
    this.zL = new Float64Array(4);
    this.zR = new Float64Array(4);
    this.cnt = 0;
    this.accL = 0;
    this.accR = 0;
    this.sumsL = []; // サブブロックごとのΣx²（チャンネルL）
    this.sumsR = [];
  }

  /** L, R はFloat32Array/Float64Array。先頭 n サンプルを処理。 */
  process(L, R, n = L.length) {
    const { shelf, highpass } = this.c;
    const sb0 = shelf.b[0], sb1 = shelf.b[1], sb2 = shelf.b[2];
    const sa1 = shelf.a[1], sa2 = shelf.a[2];
    const hb0 = highpass.b[0], hb1 = highpass.b[1], hb2 = highpass.b[2];
    const ha1 = highpass.a[1], ha2 = highpass.a[2];
    const mono = this.mono;
    const zL = this.zL, zR = this.zR;
    let l0 = zL[0], l1 = zL[1], l2 = zL[2], l3 = zL[3];
    let r0 = zR[0], r1 = zR[1], r2 = zR[2], r3 = zR[3];
    let cnt = this.cnt, accL = this.accL, accR = this.accR;
    const sub = this.sub;

    for (let i = 0; i < n; i++) {
      const xl = L[i];
      let y = sb0 * xl + l0;
      l0 = sb1 * xl - sa1 * y + l1;
      l1 = sb2 * xl - sa2 * y;
      let y2 = hb0 * y + l2;
      l2 = hb1 * y - ha1 * y2 + l3;
      l3 = hb2 * y - ha2 * y2;
      accL += y2 * y2;

      if (!mono) {
        const xr = R[i];
        y = sb0 * xr + r0;
        r0 = sb1 * xr - sa1 * y + r1;
        r1 = sb2 * xr - sa2 * y;
        y2 = hb0 * y + r2;
        r2 = hb1 * y - ha1 * y2 + r3;
        r3 = hb2 * y - ha2 * y2;
        accR += y2 * y2;
      }

      if (++cnt === sub) {
        this.sumsL.push(accL);
        this.sumsR.push(mono ? accL : accR);
        cnt = 0;
        accL = 0;
        accR = 0;
      }
    }
    zL[0] = l0; zL[1] = l1; zL[2] = l2; zL[3] = l3;
    zR[0] = r0; zR[1] = r1; zR[2] = r2; zR[3] = r3;
    this.cnt = cnt;
    this.accL = accL;
    this.accR = accR;
  }

  /** 結果。算出できない項目は null。 */
  finish() {
    const sub = this.sub;
    const n = this.sumsL.length;
    // サブブロックのエネルギー（L,R の平均二乗の和）
    const e = new Float64Array(n);
    for (let i = 0; i < n; i++) e[i] = (this.sumsL[i] + this.sumsR[i]) / sub;
    const cum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + e[i];

    const windows = (len) => {
      const count = n - len + 1;
      if (count <= 0) return new Float64Array(0);
      const out = new Float64Array(count);
      for (let j = 0; j < count; j++) out[j] = (cum[j + len] - cum[j]) / len;
      return out;
    };
    const momentary = windows(4); // 400ms
    const shortTerm = windows(30); // 3s

    return {
      integrated: gatedLoudness(momentary),
      lra: loudnessRange(shortTerm),
      momentaryMax: maxLufs(momentary),
      shortTermMax: maxLufs(shortTerm),
      blocks: { momentary: momentary.length, shortTerm: shortTerm.length },
    };
  }
}

function maxLufs(energies) {
  let m = 0;
  for (const v of energies) if (v > m) m = v;
  return m > 0 ? energyToLufs(m) : null;
}

/** 積算ラウドネス: 絶対ゲート−70 LUFS → 相対ゲート(平均−10 LU)。 */
export function gatedLoudness(energies) {
  const absE = lufsToEnergy(-70);
  let sum = 0;
  let cnt = 0;
  for (const v of energies) {
    if (v > absE) { sum += v; cnt++; }
  }
  if (cnt === 0) return null;
  const relE = lufsToEnergy(energyToLufs(sum / cnt) - 10);
  sum = 0;
  cnt = 0;
  for (const v of energies) {
    if (v > absE && v > relE) { sum += v; cnt++; }
  }
  if (cnt === 0) return null;
  return energyToLufs(sum / cnt);
}

/** LRA: ショートターム値に絶対ゲート−70・相対ゲート−20 LUを適用し、95%点−10%点。 */
export function loudnessRange(shortTermEnergies) {
  const absE = lufsToEnergy(-70);
  let sum = 0;
  let cnt = 0;
  for (const v of shortTermEnergies) {
    if (v > absE) { sum += v; cnt++; }
  }
  if (cnt === 0) return null;
  const relE = lufsToEnergy(energyToLufs(sum / cnt) - 20);
  const vals = [];
  for (const v of shortTermEnergies) {
    if (v > absE && v > relE) vals.push(energyToLufs(v));
  }
  if (vals.length === 0) return null;
  vals.sort((a, b) => a - b);
  return percentile(vals, 0.95) - percentile(vals, 0.1);
}

/** 昇順配列の線形補間パーセンタイル（numpy.percentileの既定と同じ）。 */
export function percentile(sorted, p) {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
