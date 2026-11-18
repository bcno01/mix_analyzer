// 基数2の複素FFT（in-place、前進変換: X[k] = Σ x[n]·exp(-2πi·kn/N)）。
// 表（回転因子・ビット反転）を事前計算し、同じサイズで何度も呼ぶ用途（Welch法）向け。

export class FFT {
  constructor(n) {
    if (!Number.isInteger(n) || n < 2 || (n & (n - 1)) !== 0) {
      throw new Error('FFTのサイズは2のべき乗でなければなりません: ' + n);
    }
    this.n = n;
    const half = n >> 1;
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      const a = (-2 * Math.PI * i) / n;
      this.cos[i] = Math.cos(a);
      this.sin[i] = Math.sin(a);
    }
    const bits = Math.round(Math.log2(n));
    this.rev = new Uint32Array(n);
    for (let i = 1; i < n; i++) {
      this.rev[i] = (this.rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
    }
  }

  /** re, im: 長さnのFloat64Array。結果は同じ配列に上書きされる。 */
  transform(re, im) {
    const n = this.n;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const cos = this.cos;
    const sin = this.sin;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cos[t];
          const wi = sin[t];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}
