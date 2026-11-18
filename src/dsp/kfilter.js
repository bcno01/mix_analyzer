// ITU-R BS.1770-4 のK特性フィルタ（libebur128方式）。サンプルレートごとに係数を計算する。

/** 2段のバイカッド係数を返す。b, a は [x0, x1, x2] / [1, a1, a2]。 */
export function kWeightCoefficients(fs) {
  // 第1段: ハイシェルフ
  const f0 = 1681.9744509555319;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b: [
      (Vh + (Vb * K) / Q + K * K) / a0,
      (2 * (K * K - Vh)) / a0,
      (Vh - (Vb * K) / Q + K * K) / a0,
    ],
    a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0],
  };

  // 第2段: ハイパス（bは正規化しない。libebur128と同じ）
  const f1 = 38.13547087602444;
  const Q1 = 0.5003270373238773;
  K = Math.tan((Math.PI * f1) / fs);
  a0 = 1 + K / Q1 + K * K;
  const highpass = {
    b: [1, -2, 1],
    a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q1 + K * K) / a0],
  };
  return { shelf, highpass };
}

/** 1チャンネル分のK特性フィルタ（状態を持つ）。倍精度で計算する。 */
export class KFilter {
  constructor(fs) {
    const c = kWeightCoefficients(fs);
    this.s = c.shelf;
    this.h = c.highpass;
    // 転置直接形IIの状態
    this.z = new Float64Array(4);
  }

  /** 1サンプル処理（テスト・確認用。ホットループでは loudness.js が展開して使う） */
  step(x) {
    const { s, h, z } = this;
    let y = s.b[0] * x + z[0];
    z[0] = s.b[1] * x - s.a[1] * y + z[1];
    z[1] = s.b[2] * x - s.a[2] * y;
    const x2 = y;
    y = h.b[0] * x2 + z[2];
    z[2] = h.b[1] * x2 - h.a[1] * y + z[3];
    z[3] = h.b[2] * x2 - h.a[2] * y;
    return y;
  }
}
