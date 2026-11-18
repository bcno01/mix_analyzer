// 解析結果（JSON）→ 総合スコア。画面や描画には依存しない純粋な関数。
// 出力: { version, preset, total(0〜100の整数|null), items:[{id, score, max, rows:[{key, params, points, max}]}] }
// 算出できない項目（無音・短尺など）は score:null。1つでも null なら total も null。

import { CRITERIA, PRESETS, DEFAULT_PRESET } from './criteria.js';

export const SCORE_VERSION = 1;

/** x が zeroAt のとき0、fullAt のとき1、その間は線形（どちらの向きでも可）。範囲外は0〜1に丸める。 */
export function ramp(x, zeroAt, fullAt) {
  const r = (x - zeroAt) / (fullAt - zeroAt);
  return Math.max(0, Math.min(1, r));
}

const num = (v, d = 1) => v.toFixed(d);
const signed = (v, d = 1) => (v > 0 ? '+' : '') + v.toFixed(d);
const round1 = (v) => Math.round(v * 10) / 10;

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 行（根拠）の配列から、点数の合計と配点の合計を出す。points が null の行は情報表示のみ。 */
function item(id, rows) {
  const scored = rows.filter((r) => r.points !== null);
  const max = CRITERIA.itemMax;
  if (scored.length === 0) return { id, score: null, max, rows };
  const got = scored.reduce((a, r) => a + r.points, 0);
  const avail = scored.reduce((a, r) => a + r.max, 0);
  // 算出できなかった行がある（短尺でLRAが出ない等）ときは、残りの配点を25点に換算する
  return { id, score: round1((got / avail) * max), max, rows };
}

function row(key, params, ratio, max) {
  return { key, params, points: ratio === null ? null : round1(ratio * max), max };
}

function loudnessItem(r, preset) {
  const c = CRITERIA.loudness;
  const l = r.loudness;
  const rows = [];
  if (l.integrated !== null) {
    const diff = Math.abs(l.integrated - preset.targetLufs);
    const ratio = ramp(diff, c.zeroAt, c.fullWithin);
    rows.push(row('score.row.integrated', { value: num(l.integrated), target: preset.targetLufs, diff: num(diff) }, ratio, c.integrated));
  }
  if (l.truePeak !== null) {
    const over = l.truePeak - preset.truePeakLimit; // 上限を超えた量(dB)
    const ratio = ramp(over, c.truePeakZeroOver, 0);
    rows.push(row('score.row.truePeak', { value: num(l.truePeak), limit: preset.truePeakLimit }, ratio, c.truePeak));
  }
  if (rows.length < 2) return item('loudness', []);
  return item('loudness', rows);
}

/** 標準カーブ: 125Hz〜4kHzの帯域の中央値を0とした直線（傾き tiltDbPerOct）。 */
export function standardCurve(bands, tilt = CRITERIA.spectrum.tiltDbPerOct) {
  const raw = (fc) => tilt * Math.log2(fc / 1000);
  const ref = bands.filter((b) => b.fc >= 124 && b.fc <= 4050).map((b) => raw(b.fc));
  const base = ref.length ? median(ref) : 0;
  return (fc) => raw(fc) - base;
}

function spectrumItem(r) {
  const c = CRITERIA.spectrum;
  const sp = r.spectrum;
  if (!sp) return item('spectrum', []);
  const std = standardCurve(sp.bands, c.tiltDbPerOct);
  const used = sp.bands.filter((b) => b.db !== null && b.fc >= c.fMin - 1 && b.fc <= c.fMax + 100);
  if (used.length < c.minBands) return item('spectrum', []);
  const diffs = used.map((b) => ({ fc: b.fc, d: b.db - std(b.fc) }));
  const mad = diffs.reduce((a, x) => a + Math.abs(x.d), 0) / diffs.length;
  const worst = diffs.reduce((a, x) => (Math.abs(x.d) > Math.abs(a.d) ? x : a));
  const ratio = ramp(mad, c.madZero, c.madFull);
  return item('spectrum', [
    row('score.row.spectrum', { mad: num(mad) }, ratio, CRITERIA.itemMax),
    row('score.row.spectrumWorst', { fc: Math.round(worst.fc), diff: signed(worst.d) }, null, 0),
  ]);
}

function stereoItem(r) {
  const c = CRITERIA.stereo;
  const s = r.stereo;
  if (s.correlation === null) return item('stereo', []);
  const rows = [row('score.row.corr', { value: num(s.correlation, 2) }, ramp(s.correlation, c.corrZero, c.corrFull), c.corr)];
  if (s.lowSideMinusMid !== null) {
    const v = Math.max(-99, s.lowSideMinusMid);
    rows.push(row('score.row.lowSM', { value: num(v) }, ramp(v, c.lowSMZero, c.lowSMFull), c.lowSM));
  }
  const valid = s.corrSeries.filter((p) => p.v !== null);
  if (valid.length > 0) {
    const pct = (valid.filter((p) => p.v < 0).length / valid.length) * 100;
    rows.push(row('score.row.antiphase', { pct: num(pct) }, ramp(pct, c.antiphaseZero, c.antiphaseFull), c.antiphase));
  }
  return item('stereo', rows);
}

function dynamicsItem(r) {
  const c = CRITERIA.dynamics;
  const rows = [];
  if (r.dynamics.plr !== null) rows.push(row('score.row.plr', { value: num(r.dynamics.plr) }, ramp(r.dynamics.plr, c.plrZero, c.plrFull), c.plr));
  if (r.loudness.lra !== null) rows.push(row('score.row.lra', { value: num(r.loudness.lra) }, ramp(r.loudness.lra, c.lraZero, c.lraFull), c.lra));
  return item('dynamics', rows);
}

export function scoreResult(result, presetId = DEFAULT_PRESET) {
  const preset = PRESETS[presetId] || PRESETS[DEFAULT_PRESET];
  const items = [loudnessItem(result, preset), spectrumItem(result), stereoItem(result), dynamicsItem(result)];
  const ok = items.every((i) => i.score !== null);
  const total = ok ? Math.round((items.reduce((a, i) => a + i.score, 0) / (items.length * CRITERIA.itemMax)) * 100) : null;
  return { version: SCORE_VERSION, preset: preset.id, targetLufs: preset.targetLufs, total, items };
}
