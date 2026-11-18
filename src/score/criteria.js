// 総合スコアの基準値。数値はすべてここに集約する（調整はこのファイルだけ）。
// スコアは「基準値との近さを数値化した目安」であり、聴感の評価ではない。
//
// 注意: 周波数の「標準カーブ」と各しきい値は、実装者が一般的な目安として置いた暫定値で、
// 大量の音源での統計に基づくものではない。実音源での点数の出方を見ながら調整すること。

/** ラウドネスの採点基準（画面で切り替える）。 */
export const PRESETS = {
  stream: { id: 'stream', targetLufs: -14, truePeakLimit: -1 }, // 配信向け
  loud: { id: 'loud', targetLufs: -9, truePeakLimit: -1 }, // 大きめ（クラブ/CD向け）
  broadcast: { id: 'broadcast', targetLufs: -23, truePeakLimit: -1 }, // 放送（EBU R128）
};
export const DEFAULT_PRESET = 'stream';

/** 各項目は25点満点（合計100点）。ramp(x, ゼロ点, 満点)で線形に点を決める。 */
export const CRITERIA = {
  itemMax: 25,
  loudness: {
    integrated: 15, // 積算ラウドネスが目標から ±fullWithin LU 以内なら満点、zeroAt LU 離れると0点
    fullWithin: 1,
    zeroAt: 6,
    truePeak: 10, // True Peak が上限以下なら満点、上限+2 dB で0点
    truePeakZeroOver: 2,
  },
  spectrum: {
    // 1/3オクターブ帯域のレベル（125Hz〜4kHzの中央値=0dB）と標準カーブの平均絶対差で採点
    tiltDbPerOct: -1.5, // 帯域エネルギーの傾き。ピンクノイズ(水平)から高域へ緩やかに下がる（PSDで約-4.5dB/oct）
    fMin: 40, // 評価する帯域の範囲。極低域・超高域は音源やコーデックに左右されるので除く
    fMax: 16000,
    madFull: 2.5, // 平均絶対差がこれ以下なら満点
    madZero: 9, // これ以上なら0点
    minBands: 8,
  },
  stereo: {
    corr: 10, // 全体のL/R相関
    corrFull: 0.3,
    corrZero: -0.2,
    lowSM: 8, // 低域(20-120Hz)のS−M（小さいほど低域が中央に寄っている）
    lowSMFull: -12,
    lowSMZero: 0,
    antiphase: 7, // 相関が負の区間の割合(%)
    antiphaseFull: 0,
    antiphaseZero: 20,
  },
  dynamics: {
    plr: 15, // PLR（True Peak − 積算ラウドネス）
    plrFull: 9,
    plrZero: 5,
    lra: 10, // LRA
    lraFull: 4,
    lraZero: 1,
  },
};
