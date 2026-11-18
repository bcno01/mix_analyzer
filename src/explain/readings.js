// 解析結果（JSON）→「今回の値の読み取り」。数値から言える事実だけを、ルールで文章にする。
// 聴感の評価はしない（「良い/悪い」と言わず、「〜に近い」「〜を超えている」のように書く）。
// 出力は {key, params}。文言は i18n の 'read.*' キー。params の値が {k:'キー'} のときは翻訳して埋める。

import { t } from '../i18n/index.js';
import { PRESETS, CRITERIA } from '../score/criteria.js';
import { standardCurve } from '../score/score.js';
import { fmtTime } from '../render/charts.js';

const f1 = (v) => v.toFixed(1);
const f2 = (v) => v.toFixed(2);

const REGIONS = [
  { id: 'low', lo: 40, hi: 250, range: '40–250' },
  { id: 'mid', lo: 250, hi: 4000, range: '250–4k' },
  { id: 'high', lo: 4000, hi: 16100, range: '4k–16k' },
];
const REGION_DEV_DB = 3; // 標準カーブとの平均差がこれ未満なら「ほぼ同じ」

const R = (key, params) => ({ key, params });

function loudnessReadings(r) {
  const l = r.loudness;
  const d = r.dynamics;
  const out = [];
  const target = PRESETS.stream.targetLufs;
  if (l.integrated !== null) {
    const diff = l.integrated - target;
    const p = { v: f1(l.integrated), d: f1(Math.abs(diff)) };
    if (Math.abs(diff) <= CRITERIA.loudness.fullWithin) out.push(R('read.loud.near', p));
    else out.push(R(diff > 0 ? 'read.loud.louder' : 'read.loud.quieter', p));
  }
  if (l.truePeak !== null) {
    const p = { v: f1(l.truePeak) };
    if (l.truePeak > 0) out.push(R('read.tp.over', p));
    else if (l.truePeak > PRESETS.stream.truePeakLimit) out.push(R('read.tp.hot', p));
    else out.push(R('read.tp.ok', p));
  }
  if (d.plr !== null) {
    const p = { v: f1(d.plr) };
    out.push(R(d.plr < 8 ? 'read.plr.low' : d.plr < 12 ? 'read.plr.mid' : 'read.plr.high', p));
  }
  if (l.lra !== null) {
    const p = { v: f1(l.lra) };
    out.push(R(l.lra < 3 ? 'read.lra.low' : l.lra <= 8 ? 'read.lra.mid' : 'read.lra.high', p));
  }
  if (l.samplePeak !== null) {
    out.push(l.clipSamples > 0 ? R('read.clip.some', { n: l.clipSamples }) : R('read.clip.none'));
  }
  return out;
}

function frequencyReadings(r) {
  const sp = r.spectrum;
  const out = [];
  if (!sp) return out;
  const total = sp.seven.reduce((a, s) => a + (s.percent ?? 0), 0);
  if (total > 0) {
    let best = 0;
    sp.seven.forEach((s, i) => { if ((s.percent ?? 0) > (sp.seven[best].percent ?? 0)) best = i; });
    const s = sp.seven[best];
    const sh = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));
    out.push(R('read.freq.peak', { name: { k: `band.${best}` }, range: `${sh(s.lo)}–${sh(s.hi)}`, pct: f1(s.percent) }));
  }
  const std = standardCurve(sp.bands, CRITERIA.spectrum.tiltDbPerOct);
  for (const reg of REGIONS) {
    const used = sp.bands.filter((b) => b.db !== null && b.fc >= reg.lo && b.fc < reg.hi);
    if (used.length === 0) continue;
    const dev = used.reduce((a, b) => a + (b.db - std(b.fc)), 0) / used.length;
    const p = { name: { k: `region.${reg.id}` }, range: reg.range, d: f1(Math.abs(dev)) };
    out.push(R(Math.abs(dev) < REGION_DEV_DB ? 'read.freq.ok' : dev > 0 ? 'read.freq.high' : 'read.freq.low', p));
  }
  const top = sp.bands.filter((b) => b.fc >= 16000);
  if (top.length > 0 && top.every((b) => b.db !== null && b.db <= -40)) out.push(R('read.freq.lowpass'));
  return out;
}

function stereoReadings(r) {
  const s = r.stereo;
  const sp = r.spectrum;
  const out = [];
  if (s.correlation !== null) {
    const v = s.correlation;
    const p = { v: (v > 0 ? '+' : '') + f2(v) };
    out.push(R(v >= 0.9 ? 'read.st.mono' : v >= 0.3 ? 'read.st.ok' : v >= 0 ? 'read.st.wide' : 'read.st.anti', p));
  }
  if (s.sideRatio !== null && s.sideMinusMid !== null) {
    out.push(R('read.st.side', { p: f1(s.sideRatio), sm: s.sideMinusMid <= -90 ? '-∞' : f1(s.sideMinusMid) }));
  }
  if (s.lowSideMinusMid !== null) {
    const v = Math.max(-99, s.lowSideMinusMid);
    const c = CRITERIA.stereo;
    out.push(R(v <= c.lowSMFull ? 'read.st.low.center' : v <= -6 ? 'read.st.low.mid' : 'read.st.low.wide', { v: f1(v) }));
  }
  const valid = s.corrSeries.filter((p) => p.v !== null);
  if (valid.length > 0) {
    const pct = (valid.filter((p) => p.v < 0).length / valid.length) * 100;
    out.push(pct === 0 ? R('read.st.anti.none') : R('read.st.anti.some', { p: f1(pct) }));
  }
  if (sp) {
    const neg = sp.bands.filter((b) => b.correlation !== null && b.correlation < 0 && b.db !== null && b.db > -30);
    if (neg.length > 0) {
      const names = neg.slice(0, 4).map((b) => `${b.fc >= 1000 ? (b.fc / 1000).toFixed(b.fc >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : Math.round(b.fc)} Hz`);
      out.push(R('read.st.bandsNeg', { list: names.join(', ') + (neg.length > 4 ? '…' : '') }));
    }
  }
  return out;
}

function timeReadings(r) {
  const out = [];
  const cs = r.dynamics.crestSeries.filter((p) => p.v !== null);
  if (cs.length > 0) {
    const vals = cs.map((p) => p.v);
    out.push(R('read.time.crest', { min: f1(Math.min(...vals)), max: f1(Math.max(...vals)), mean: f1(r.dynamics.crestMean ?? vals.reduce((a, b) => a + b, 0) / vals.length) }));
  }
  const corr = r.stereo.corrSeries.filter((p) => p.v !== null);
  if (corr.length > 0) {
    const m = corr.reduce((a, p) => (p.v < a.v ? p : a));
    out.push(R('read.time.corrMin', { min: (m.v > 0 ? '+' : '') + f2(m.v), time: fmtTime(m.t) }));
  }
  return out;
}

/** @returns {{loudness:object[], freq:object[], stereo:object[], time:object[]}} */
export function buildReadings(result) {
  return {
    loudness: loudnessReadings(result),
    freq: frequencyReadings(result),
    stereo: stereoReadings(result),
    time: timeReadings(result),
  };
}

/** {key, params} → 表示用の文字列。params の {k:'キー'} は翻訳して埋める。 */
export function formatReading(r) {
  let params;
  if (r.params) {
    params = {};
    for (const [k, v] of Object.entries(r.params)) params[k] = v && typeof v === 'object' ? t(v.k) : v;
  }
  return t(r.key, params);
}
