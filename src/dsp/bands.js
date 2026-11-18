// PSDから帯域エネルギー・ステレオ指標を作る。

export const SEVEN_BANDS = [
  [20, 60],
  [60, 250],
  [250, 500],
  [500, 2000],
  [2000, 4000],
  [4000, 8000],
  [8000, 20000],
];

/** 1/3オクターブ帯域（fc=1000·2^(k/3)、k=-16〜、上限エッジがナイキスト以下）。 */
export function thirdOctaveBands(fs) {
  const nyq = fs / 2;
  const out = [];
  for (let k = -16; ; k++) {
    const fc = 1000 * Math.pow(2, k / 3);
    const lo = fc / Math.pow(2, 1 / 6);
    const hi = fc * Math.pow(2, 1 / 6);
    if (hi > nyq) break;
    out.push({ k, fc, lo, hi });
  }
  return out;
}

/** PSD（ビンkは[(k-0.5)df,(k+0.5)df]で一定とみなす）を[lo,hi]Hzで積分。端のビンは重みを按分。 */
export function integratePsd(psd, df, lo, hi) {
  const kLo = Math.max(0, Math.floor(lo / df - 0.5));
  const kHi = Math.min(psd.length - 1, Math.ceil(hi / df + 0.5));
  let sum = 0;
  for (let k = kLo; k <= kHi; k++) {
    const a = Math.max(lo, (k - 0.5) * df);
    const b = Math.min(hi, (k + 0.5) * df);
    if (b > a) sum += psd[k] * (b - a);
  }
  return sum;
}

const db10 = (v) => 10 * Math.log10(v);

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const SM_LIMIT_DB = 120;

/** S−M(dB)。ΣS²とΣM²から。どちらかがほぼ0でも±120 dBで丸め、両方0なら null。 */
export function sideMinusMidDb(s, m) {
  const ss = Math.max(s, 0);
  const mm = Math.max(m, 0);
  const total = ss + mm;
  if (!(total > 0)) return null;
  const floor = 1e-12 * total;
  const v = db10(Math.max(ss, floor) / Math.max(mm, floor));
  return Math.max(-SM_LIMIT_DB, Math.min(SM_LIMIT_DB, v));
}

/** M=(L+R)/2, S=(L−R)/2 の帯域パワー（PSD積分）を、L/Rパワーとクロススペクトル実部から求める。 */
function smDb(ll, rr, lrRe) {
  return sideMinusMidDb((ll + rr - 2 * lrRe) / 4, (ll + rr + 2 * lrRe) / 4);
}

/**
 * @param {object|null} welch WelchAccumulator.finish() の結果
 * @returns スペクトル・ステレオの帯域指標。welch が null なら null。
 */
export function analyzeSpectrum(welch) {
  if (!welch) return null;
  const { fs, df, pll, prr, plr } = welch;
  const nyq = fs / 2;
  const avg = new Float64Array(pll.length);
  for (let k = 0; k < avg.length; k++) avg[k] = (pll[k] + prr[k]) / 2;

  // 1/3オクターブ帯域
  const defs = thirdOctaveBands(fs);
  const bands = defs.map((b) => {
    const e = integratePsd(avg, df, b.lo, b.hi);
    const ll = integratePsd(pll, df, b.lo, b.hi);
    const rr = integratePsd(prr, df, b.lo, b.hi);
    const lr = integratePsd(plr, df, b.lo, b.hi);
    const den = Math.sqrt(ll * rr);
    return {
      k: b.k,
      fc: b.fc,
      lo: b.lo,
      hi: b.hi,
      energy: e,
      sideMinusMid: smDb(ll, rr, lr),
      correlation: den > 0 ? Math.max(-1, Math.min(1, lr / den)) : null,
    };
  });

  // 125〜4kHzの帯域の中央値を0 dBとして相対表示
  const refVals = bands.filter((b) => b.fc >= 124 && b.fc <= 4050 && b.energy > 0).map((b) => db10(b.energy));
  const refDb = refVals.length ? median(refVals) : null;
  for (const b of bands) {
    b.db = refDb !== null && b.energy > 0 ? db10(b.energy) - refDb : null;
  }

  // 7帯域のエネルギー比
  const raw = SEVEN_BANDS.map(([lo, hi]) => {
    const h = Math.min(hi, nyq);
    return h > lo ? integratePsd(avg, df, lo, h) : 0;
  });
  const total = raw.reduce((a, b) => a + b, 0);
  const seven = SEVEN_BANDS.map(([lo, hi], i) => ({
    lo,
    hi,
    percent: total > 0 ? (raw[i] / total) * 100 : null,
  }));

  // 低域(20〜120Hz)のS−M
  const lowLL = integratePsd(pll, df, 20, 120);
  const lowRR = integratePsd(prr, df, 20, 120);
  const lowLR = integratePsd(plr, df, 20, 120);

  return {
    nperseg: welch.nperseg,
    segments: welch.segments,
    refDb,
    bands,
    seven,
    lowSideMinusMid: smDb(lowLL, lowRR, lowLR),
  };
}
