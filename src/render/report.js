// 解析結果（JSON）→ 1枚の画像（幅1600px）。画面表示とPNG保存で同じ関数を使う。
// デザインは「計測シート」: 方眼紙の上に、罫線で区切った表題欄・読み取り表・白いシートに載せた図。
// 各節の下に「見方」（グラフの読み方）と「今回の読み取り」（数値から言えること）を併記する。
// 文言はすべて i18n の t() を通す。解析結果の構造は pipeline.js の RESULT_VERSION を参照。

import { t } from '../i18n/index.js';
import { PRESETS } from '../score/criteria.js';
import { SEVEN_BANDS } from '../dsp/bands.js';
import { buildReadings, formatReading } from '../explain/readings.js';
import {
  THEME, font, fmt, fmtSigned, fmtTime, fmtHz, text, wrapLines, noData,
  drawBandBars, drawBandLine, drawSeries, drawHBars, drawGoniometer, niceRange,
} from './charts.js';

export const REPORT_WIDTH = 1600;
const M = 56; // 外側の余白
const CW = REPORT_WIDTH - M * 2; // 内容幅
const SECTION_GAP = 40;
const HEAD = 64; // 見出し（罫線＋題）の高さ
const SUB = 58; // 図の小見出しの高さ
const CELL_H = 176; // 読み取り表の1段の高さ
const EX_PAD = 26; // 説明帯の内側余白
const EX_LEFT = 600; // 説明帯の左の列の幅
const EX_GAP = 48;
const TXT = 15.5;
const LH = 22; // 説明文の行の高さ

/** 画面にも出す注意書き（元のレートと違う、先頭2chのみ使用、無音、短尺など）。 */
export function getWarnings(result) {
  const w = [];
  const m = result.meta;
  if (m.resampled) w.push(t('warn.resampled', { from: m.sourceSampleRate, to: m.sampleRate }));
  else if (m.rateUnknown) w.push(t('warn.rateUnknown', { to: m.sampleRate }));
  if (m.sourceChannels > 2) w.push(t('warn.channels', { n: m.sourceChannels }));
  if (result.loudness.samplePeak === null) w.push(t('warn.silent'));
  else if (result.loudness.lra === null && result.loudness.shortTermMax === null) w.push(t('warn.short'));
  return w;
}

/** 画面の読み上げ・代替テキスト用の要約。 */
export function summarize(result) {
  const l = result.loudness;
  return t('result.alt', {
    name: result.meta.fileName || '',
    lufs: fmt(l.integrated, 1),
    tp: fmt(l.truePeak, 1),
    lra: fmt(l.lra, 1),
    corr: fmt(result.stereo.correlation, 2),
  });
}

// ---------------------------------------------------------------- 説明帯（見方＋今回の読み取り）
/** 左: 見方（見出し＋本文の並び）、右: 今回の読み取り（箇条書き）。折り返しを先に計算して高さを返す。 */
function explainLayout(ctx, how, readings, leftMin = 0) {
  const leftW = EX_LEFT;
  const rightW = CW - EX_PAD * 2 - EX_LEFT - EX_GAP;
  const left = how.map((h) => ({ head: h.head, lines: wrapLines(ctx, h.body, leftW, TXT) }));
  const right = readings.map((r) => wrapLines(ctx, formatReading(r), rightW - 22, TXT));
  let hl = 0;
  for (const h of left) hl += 26 + h.lines.length * LH + 10;
  let hr = 0;
  for (const lines of right) hr += lines.length * LH + 10;
  const body = Math.max(hl, hr, leftMin);
  return { left, right, rightW, h: EX_PAD + 34 + body + EX_PAD - 6 };
}

function drawExplainFrame(ctx, y, lay, leftTitle) {
  ctx.fillStyle = THEME.card;
  ctx.fillRect(M, y, CW, lay.h);
  ctx.strokeStyle = THEME.cardBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(M + 0.5, y + 0.5, CW - 1, lay.h - 1);
  const lx = M + EX_PAD;
  const rx = lx + EX_LEFT + EX_GAP;
  ctx.fillStyle = THEME.cardBorder;
  ctx.fillRect(lx + EX_LEFT + EX_GAP / 2, y + EX_PAD, 1, lay.h - EX_PAD * 2);
  if (leftTitle) text(ctx, leftTitle, lx, y + EX_PAD + 18, { size: 18, weight: 800, stretch: 'expanded' });
  text(ctx, t('ex.reading'), rx, y + EX_PAD + 18, { size: 18, weight: 800, stretch: 'expanded' });
  // 今回の読み取り（箇条書き）
  let ty = y + EX_PAD + 34 + 18;
  if (lay.right.length === 0) text(ctx, t('report.noData'), rx, ty, { size: TXT, color: THEME.muted });
  for (const lines of lay.right) {
    ctx.fillStyle = THEME.accent;
    ctx.fillRect(rx, ty - 10, 8, 8);
    lines.forEach((ln, i) => text(ctx, ln, rx + 22, ty + i * LH, { size: TXT }));
    ty += lines.length * LH + 10;
  }
  return { lx, rx };
}

function drawExplain(ctx, y, lay) {
  const { lx } = drawExplainFrame(ctx, y, lay, t('ex.how'));
  let ty = y + EX_PAD + 34 + 18;
  for (const h of lay.left) {
    text(ctx, h.head, lx, ty, { size: 16, weight: 700 });
    ty += 26;
    h.lines.forEach((ln, i) => text(ctx, ln, lx, ty - 4 + i * LH, { size: TXT, color: THEME.text }));
    ty += h.lines.length * LH - 4 + 10 - 4;
  }
}

// ---------------------------------------------------------------- レイアウト
const TILES_H = 3 + CELL_H * 2 + 1;

function layout(result, ctx) {
  const warnings = getWarnings(result);
  const rd = buildReadings(result);
  const how = (ids) => ids.map((id) => ({ head: t(`how.${id}.head`), body: t(`how.${id}`) }));
  const ex = {
    readout: explainLayout(ctx, [], rd.loudness, 168),
    freq: explainLayout(ctx, how(['freq.third', 'freq.seven']), rd.freq),
    stereo: explainLayout(ctx, how(['st.gonio', 'st.sm', 'st.corr']), rd.stereo),
    time: explainLayout(ctx, how(['time.corr', 'time.crest']), rd.time),
  };
  const L = { warnings, ex };
  let y = 0;
  const block = (name, h, gap = SECTION_GAP) => {
    L[name] = { y, h };
    y += h + gap;
  };
  block('header', 262, 36);
  block('score', HEAD + 424 + 24);
  block('readout', TILES_H + 24 + ex.readout.h);
  block('freq', HEAD + SUB + 372 + 24 + ex.freq.h);
  block('stereo', HEAD + SUB + 392 + 44 + 24 + ex.stereo.h);
  block('time', HEAD + SUB + 252 + 24 + ex.time.h);
  block('footer', 110 + warnings.length * 30, 0);
  L.height = y;
  return L;
}

export function renderReport(canvas, result, opts = {}) {
  const L = layout(result, canvas.getContext('2d'));
  canvas.width = REPORT_WIDTH; // 幅・高さを変えるとコンテキストの状態が初期化される
  canvas.height = L.height;
  draw(canvas.getContext('2d'), result, L, opts);
  return L.height;
}

// ---------------------------------------------------------------- 共通部品
function paper(ctx, height) {
  ctx.fillStyle = THEME.bg;
  ctx.fillRect(0, 0, REPORT_WIDTH, height);
  // 方眼: 16px間隔、80pxごとに少し濃い線
  for (let x = 0; x <= REPORT_WIDTH; x += 16) {
    ctx.fillStyle = x % 80 === 0 ? THEME.gridMajor : THEME.grid;
    ctx.globalAlpha = x % 80 === 0 ? 0.55 : 0.5;
    ctx.fillRect(x, 0, 1, height);
  }
  for (let y = 0; y <= height; y += 16) {
    ctx.fillStyle = y % 80 === 0 ? THEME.gridMajor : THEME.grid;
    ctx.globalAlpha = y % 80 === 0 ? 0.55 : 0.5;
    ctx.fillRect(0, y, REPORT_WIDTH, 1);
  }
  ctx.globalAlpha = 1;
}

function rule(ctx, y, weight = 2, x0 = M, x1 = M + CW) {
  ctx.fillStyle = THEME.text;
  ctx.fillRect(x0, y, x1 - x0, weight);
}

/** 節の見出し: 太い罫線＋幅広の題。内容の開始 y を返す。 */
function section(ctx, y, title) {
  rule(ctx, y, 3);
  text(ctx, title, M, y + 44, { size: 27, weight: 800, stretch: 'expanded' });
  return y + HEAD;
}

/** 図の小見出し（題＋補足）。 */
function sub(ctx, x, y, title, note, maxW) {
  text(ctx, title, x, y + 20, { size: 20, weight: 700, maxWidth: maxW });
  if (note) text(ctx, note, x, y + 44, { size: 15, color: THEME.muted, maxWidth: maxW });
}

/** 図を載せる白いシート。 */
function panel(ctx, x, y, w, h) {
  ctx.fillStyle = THEME.card;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = THEME.cardBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

const inset = (r, d = 14) => ({ x: r.x + d, y: r.y + d, w: r.w - d * 2, h: r.h - d * 2 });

// ---------------------------------------------------------------- 描画
function draw(ctx, r, L, opts) {
  paper(ctx, L.height);
  drawHeader(ctx, r, L.header.y, opts);
  drawScore(ctx, L.score.y, opts.score);
  drawReadout(ctx, r, L.readout.y, L.ex.readout);
  drawFrequency(ctx, r, L.freq.y, L.ex.freq);
  drawStereo(ctx, r, L.stereo.y, L.ex.stereo);
  drawTime(ctx, r, L.time.y, L.ex.time);
  drawFooter(ctx, L.footer.y, L.warnings);
}

function drawHeader(ctx, r, y, opts) {
  const meta = r.meta;
  text(ctx, t('report.title'), M, y + 108, { size: 92, weight: 800, stretch: 'expanded', maxWidth: CW });

  // 表題欄（図面の表題欄のように、罫線で区切った項目の並び）
  const top = y + 150;
  const h = 92;
  const rate = `${(meta.sampleRate / 1000).toFixed(meta.sampleRate % 1000 ? 1 : 0)} kHz`;
  const cells = [
    [t('meta.file'), meta.fileName || '—', 470],
    [t('meta.duration'), fmtTime(meta.duration), 150],
    [t('meta.sampleRate'), rate, 190],
    [t('meta.channels'), meta.isMono ? t('report.mono') : t('report.stereo'), 180],
    [t('meta.format'), meta.format || '—', 240],
    [t('meta.date'), opts.dateLabel || '—', CW - 470 - 150 - 190 - 180 - 240],
  ];
  rule(ctx, top, 3);
  let x = M;
  cells.forEach(([label, value, w], i) => {
    if (i > 0) {
      ctx.fillStyle = THEME.text;
      ctx.fillRect(x, top + 3, 1, h - 3);
    }
    const pad = i === 0 ? 0 : 18;
    text(ctx, label, x + pad, top + 32, { size: 15, weight: 500, color: THEME.muted });
    text(ctx, value, x + pad, top + 68, { size: 25, weight: 700, maxWidth: w - pad - 14 });
    x += w;
  });
  rule(ctx, top + h, 1);
}

/** 総合スコア: 巨大な数字と目盛り。項目別は25目盛りのセグメントメーター。 */
function drawScore(ctx, y, sc) {
  const top = section(ctx, y, t('score.title'));
  if (!sc) return;

  // 左: 総合点
  const base = top + 190;
  const num = sc.total === null ? '—' : String(sc.total);
  text(ctx, num, M - 6, base, { size: 220, weight: 800, stretch: 'expanded' });
  ctx.font = font(220, 800, 'expanded');
  const nw = ctx.measureText(num).width;
  text(ctx, t('score.outOf'), M + nw + 4, base, { size: 34, weight: 600, color: THEME.muted });

  // 目盛り（0〜100）
  const rx = M;
  const rw = 470;
  const ry = base + 66;
  ctx.fillStyle = '#d9dee6';
  ctx.fillRect(rx, ry, rw, 16);
  if (sc.total !== null) {
    ctx.fillStyle = THEME.accent;
    ctx.fillRect(rx, ry, (rw * sc.total) / 100, 16);
    // 蛍光ピンクの目印（下向きの三角）
    const mx = rx + (rw * sc.total) / 100;
    ctx.fillStyle = THEME.accent2;
    ctx.beginPath();
    ctx.moveTo(mx - 11, ry - 16);
    ctx.lineTo(mx + 11, ry - 16);
    ctx.lineTo(mx, ry - 1);
    ctx.closePath();
    ctx.fill();
  }
  for (let v = 0; v <= 100; v += 5) {
    const tx = rx + (rw * v) / 100;
    const major = v % 10 === 0;
    ctx.fillStyle = THEME.text;
    ctx.fillRect(Math.round(tx) - (v === 100 ? 1 : 0), ry + 16, 1, major ? 12 : 6);
    if (v % 50 === 0) text(ctx, String(v), tx, ry + 48, { size: 15, color: THEME.muted, align: v === 0 ? 'left' : v === 100 ? 'right' : 'center' });
  }
  const presetName = t('score.preset.' + sc.preset);
  const cap = wrapLines(ctx, t('score.caption', { preset: presetName }), rw, 15);
  cap.slice(0, 4).forEach((ln, i) => text(ctx, ln, rx, ry + 84 + i * 21, { size: 15, color: THEME.muted }));

  // 右: 項目別（2×2）
  const gx = M + 560;
  const gw = CW - 560;
  const colW = (gw - 56) / 2;
  const rowPitch = 226;
  sc.items.forEach((it, i) => {
    const x = gx + (i % 2) * (colW + 56);
    const iy = top + 4 + Math.floor(i / 2) * rowPitch;
    text(ctx, t('score.item.' + it.id), x, iy + 24, { size: 23, weight: 700, maxWidth: colW - 130 });
    const val = it.score === null ? '—' : fmt(it.score, 1);
    text(ctx, `/ ${it.max}`, x + colW, iy + 24, { size: 16, weight: 600, color: THEME.muted, align: 'right' });
    ctx.font = font(16, 600);
    const slashW = ctx.measureText(`/ ${it.max}`).width;
    text(ctx, val, x + colW - slashW - 8, iy + 26, { size: 31, weight: 800, stretch: 'expanded', align: 'right' });

    // 25目盛りのセグメント（1目盛り=1点）
    const segGap = 3;
    const segW = (colW - segGap * 24) / 25;
    for (let k = 0; k < 25; k++) {
      const sx = x + k * (segW + segGap);
      ctx.fillStyle = '#d9dee6';
      ctx.fillRect(sx, iy + 42, segW, 18);
      if (it.score !== null) {
        const fill = Math.max(0, Math.min(1, it.score - k));
        if (fill > 0) {
          ctx.fillStyle = THEME.accent;
          ctx.fillRect(sx, iy + 42, segW * fill, 18);
        }
      }
    }

    // 根拠（数値）
    let ty = iy + 90;
    if (it.rows.length === 0) text(ctx, t('score.na'), x, ty, { size: 15.5, color: THEME.muted });
    for (const row of it.rows) {
      const pts = row.points === null ? '' : `${fmt(row.points, 1)}/${row.max}`;
      const lines = wrapLines(ctx, t(row.key, row.params), colW - 84, 15.5).slice(0, 2);
      lines.forEach((ln, k) => text(ctx, ln, x, ty + k * 20, { size: 15.5, color: row.points === null ? THEME.muted : THEME.text }));
      if (pts) text(ctx, pts, x + colW, ty, { size: 15.5, weight: 600, stretch: 'condensed', align: 'right' });
      ty += lines.length * 20 + 10;
    }
  });
}

/** ラウドネスの位置: -36〜0 LUFS の目盛りに、放送・配信・大きめの目安と、この曲の位置を並べる。 */
function drawLoudnessScale(ctx, x, y, w, value) {
  const lo = -36;
  const xOf = (v) => x + ((Math.min(0, Math.max(lo, v)) - lo) / -lo) * w;
  text(ctx, t('ex.scale.title'), x, y + 18, { size: 18, weight: 800, stretch: 'expanded' });
  text(ctx, t('ex.scale.sub'), x, y + 42, { size: 14.5, color: THEME.muted, maxWidth: w });

  const barY = y + 108;
  ctx.fillStyle = '#d9dee6';
  ctx.fillRect(x, barY, w, 18);
  if (value !== null) {
    ctx.fillStyle = THEME.accent;
    ctx.fillRect(x, barY, xOf(value) - x, 18);
  }
  // 目盛り（3 LUごと、6 LUごとに数字）
  for (let v = lo; v <= 0; v += 3) {
    const tx = Math.round(xOf(v));
    const major = v % 6 === 0;
    ctx.fillStyle = THEME.text;
    ctx.fillRect(Math.min(tx, x + w - 1), barY + 18, 1, major ? 11 : 6);
    if (major) text(ctx, fmt(v, 0), xOf(v), barY + 48, { size: 14, color: THEME.muted, align: v === lo ? 'left' : v === 0 ? 'right' : 'center' });
  }
  // 目安（棒の上）
  const marks = [
    ['scale.broadcast', PRESETS.broadcast.targetLufs],
    ['scale.stream', PRESETS.stream.targetLufs],
    ['scale.loud', PRESETS.loud.targetLufs],
  ];
  for (const [key, v] of marks) {
    const mx = Math.round(xOf(v)) + 0.5;
    ctx.fillStyle = THEME.text;
    ctx.fillRect(mx - 0.5, barY - 22, 2, 22);
    text(ctx, `${t(key)} ${v}`, mx, barY - 30, { size: 15, weight: 600, align: 'center' });
  }
  // この曲の位置（蛍光ピンクの三角と値）
  if (value !== null) {
    const mx = xOf(value);
    ctx.fillStyle = THEME.accent2;
    ctx.beginPath();
    ctx.moveTo(mx, barY + 20);
    ctx.lineTo(mx - 10, barY + 40);
    ctx.lineTo(mx + 10, barY + 40);
    ctx.closePath();
    ctx.fill();
    const label = `${t('scale.this')} ${fmt(value, 1)}`;
    const right = mx > x + w - 120;
    text(ctx, label, right ? x + w : mx, barY + 76, { size: 17, weight: 800, align: right ? 'right' : 'center' });
  }
}

/** 読み取り表: 箱を使わず、縦の罫線で区切った数値の並び。各数値の下に一文の意味を付ける。 */
function drawReadout(ctx, r, y, ex) {
  const lo = r.loudness;
  const dy = r.dynamics;
  const st = r.stereo;
  const rows = [
    [
      ['tile.integrated', fmt(lo.integrated, 1), 'LUFS', 'integrated'],
      ['tile.lra', fmt(lo.lra, 1), 'LU', 'lra'],
      ['tile.truePeak', fmt(lo.truePeak, 1), 'dBTP', 'truePeak'],
      ['tile.samplePeak', fmt(lo.samplePeak, 1), 'dBFS', 'samplePeak'],
      ['tile.plr', fmt(dy.plr, 1), 'dB', 'plr'],
      ['tile.crest', fmt(dy.crest, 1), 'dB', 'crest'],
    ],
    [
      ['tile.rms', fmt(dy.rms, 1), 'dBFS', 'rms'],
      ['tile.momMax', fmt(lo.momentaryMax, 1), 'LUFS', 'momMax'],
      ['tile.stMax', fmt(lo.shortTermMax, 1), 'LUFS', 'stMax'],
      ['tile.clip', lo.samplePeak === null ? '—' : String(lo.clipSamples), t('unit.samples'), 'clip'],
      ['tile.corr', fmt(st.correlation, 2), '', 'corr'],
      ['tile.side', fmt(st.sideRatio, 1), '%', 'side'],
    ],
  ];
  const cw = CW / 6;
  rule(ctx, y, 3);
  rows.forEach((row, ri) => {
    const ry = y + 3 + ri * CELL_H;
    row.forEach(([labelKey, value, unit, id], ci) => {
      const x = M + ci * cw;
      if (ci > 0) {
        ctx.fillStyle = THEME.cardBorder;
        ctx.fillRect(x, ry + 14, 1, CELL_H - 28);
      }
      const pad = ci === 0 ? 0 : 20;
      const inner = cw - pad - 16;
      text(ctx, t(labelKey), x + pad, ry + 34, { size: 16, weight: 700, color: THEME.text, maxWidth: inner });
      text(ctx, value, x + pad, ry + 90, { size: 50, weight: 700, stretch: 'semi-expanded' });
      if (unit) {
        ctx.font = font(50, 700, 'semi-expanded');
        const vw = ctx.measureText(value).width;
        text(ctx, unit, x + pad + vw + 8, ry + 90, { size: 18, weight: 500, color: THEME.muted });
      }
      // 一文の意味（最大2行）
      const lines = wrapLines(ctx, t(`g.${id}.short`), inner, 14.5).slice(0, 2);
      lines.forEach((ln, k) => text(ctx, ln, x + pad, ry + 120 + k * 19, { size: 14.5, color: THEME.muted }));
    });
    if (ri === 0) rule(ctx, ry + CELL_H - 1, 1);
  });
  rule(ctx, y + 3 + 2 * CELL_H, 1);

  // 説明帯: 左にラウドネスの位置、右に今回の読み取り
  const ey = y + TILES_H + 24;
  const { lx } = drawExplainFrame(ctx, ey, ex, '');
  drawLoudnessScale(ctx, lx, ey + EX_PAD, EX_LEFT, lo.integrated);
}

function drawFrequency(ctx, r, y, ex) {
  const sp = r.spectrum;
  const top = section(ctx, y, t('sec.freq'));
  const ph = 372;
  const leftW = 1000;

  sub(ctx, M, top, t('freq.third'), t('freq.thirdSub'), leftW);
  const lp = { x: M, y: top + SUB, w: leftW, h: ph };
  panel(ctx, lp.x, lp.y, lp.w, lp.h);
  if (sp && sp.bands.some((b) => b.db !== null)) {
    const vals = sp.bands.map((b) => b.db).filter((v) => v !== null);
    const [yMin, yMax] = niceRange(Math.min(...vals) - 2, Math.max(...vals) + 2, 6, 24);
    const items = sp.bands.map((b) => ({ label: ((b.k % 3) + 3) % 3 === 0 ? fmtHz(b.fc) : '', v: b.db }));
    const nyq = sp.bands[sp.bands.length - 1].hi;
    const zones = SEVEN_BANDS.map(([lo, hi], i) => ({ lo: Math.max(lo, sp.bands[0].lo), hi: Math.min(hi, nyq), label: t(`band.${i}`) })).filter((z) => z.hi > z.lo);
    drawBandBars(ctx, inset(lp), items, {
      yMin, yMax, step: 6, refLine: 0, tick: (v) => fmtSigned(v, 0), bottom: 66, zones, k0: sp.bands[0].k,
    });
    legendLine(ctx, M + leftW - 250, top + 18, t('freq.pink'));
  } else noData(ctx, lp, t('report.noData'));

  const rx = M + leftW + 40;
  const rw = CW - leftW - 40;
  sub(ctx, rx, top, t('freq.seven'), '', rw);
  const rp = { x: rx, y: top + SUB, w: rw, h: ph };
  panel(ctx, rp.x, rp.y, rp.w, rp.h);
  if (sp && sp.seven.some((s) => s.percent !== null)) {
    const items = sp.seven.map((s, i) => ({ label: t(`band.${i}`), sub: `${shortHz(s.lo)}–${shortHz(s.hi)} Hz`, v: s.percent }));
    drawHBars(ctx, inset(rp, 20), items, { labelW: 150 });
  } else noData(ctx, rp, t('report.noData'));

  drawExplain(ctx, top + SUB + ph + 24, ex);
}

function legendLine(ctx, x, y, label) {
  ctx.save();
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = THEME.accent2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 44, y);
  ctx.stroke();
  ctx.restore();
  text(ctx, label, x + 54, y + 5, { size: 15, color: THEME.muted });
}

function drawStereo(ctx, r, y, ex) {
  const st = r.stereo;
  const sp = r.spectrum;
  const lo = r.loudness;
  const top = section(ctx, y, t('sec.stereo'));
  const ph = 392;
  const gapX = 40;
  const w1 = 392;
  const w2 = 520;
  const w3 = CW - w1 - w2 - gapX * 2;

  // ゴニオメーター
  sub(ctx, M, top, t('st.gonio'), t('st.gonioSub'), w1);
  const gp = { x: M, y: top + SUB, w: w1, h: ph };
  if (st.goniometer.length > 0 && lo.samplePeak !== null) {
    drawGoniometer(ctx, gp, st.goniometer, { mid: 'M', ul: 'R', ur: 'L', side: 'S' });
  } else {
    panel(ctx, gp.x, gp.y, gp.w, gp.h);
    noData(ctx, gp, t('report.noData'));
  }

  const bands = sp ? sp.bands : [];
  // 帯域別 S−M
  const x2 = M + w1 + gapX;
  sub(ctx, x2, top, t('st.bandSM'), t('st.bandSMSub'), w2);
  const sp2 = { x: x2, y: top + SUB, w: w2, h: ph };
  panel(ctx, sp2.x, sp2.y, sp2.w, sp2.h);
  if (bands.some((b) => b.sideMinusMid !== null)) {
    const vals = bands.map((b) => b.sideMinusMid).filter((v) => v !== null && v > -90);
    const mn = vals.length ? Math.min(...vals) : -12;
    const mx = vals.length ? Math.max(...vals) : 0;
    const [yMin, yMax] = niceRange(Math.min(mn, -6) - 1, Math.max(mx, 0) + 1, 6, 12);
    const items = bands.map((b) => ({ label: ((b.k % 3) + 3) % 3 === 0 ? fmtHz(b.fc) : '', v: b.sideMinusMid === null ? null : Math.max(b.sideMinusMid, yMin) }));
    drawBandBars(ctx, inset(sp2), items, { yMin, yMax, step: 6, tick: (v) => fmtSigned(v, 0) });
  } else noData(ctx, sp2, t('report.noData'));
  const ly = top + SUB + ph + 32;
  text(ctx, t('st.lowSM'), x2, ly, { size: 17, weight: 500, color: THEME.muted });
  text(ctx, `${fmt(st.lowSideMinusMid, 1)} dB`, x2 + w2, ly, { size: 22, weight: 700, stretch: 'semi-expanded', align: 'right' });

  // 帯域別 L/R相関
  const x3 = x2 + w2 + gapX;
  sub(ctx, x3, top, t('st.bandCorr'), '', w3);
  const bp = { x: x3, y: top + SUB, w: w3, h: ph };
  panel(ctx, bp.x, bp.y, bp.w, bp.h);
  if (bands.some((b) => b.correlation !== null)) {
    const items = bands.map((b) => ({ label: ((b.k % 3) + 3) % 3 === 0 ? fmtHz(b.fc) : '', v: b.correlation }));
    drawBandLine(ctx, inset(bp), items, { yMin: -1, yMax: 1, step: 0.5, tick: (v) => fmt(v, 1), color: THEME.accent3 });
  } else noData(ctx, bp, t('report.noData'));

  drawExplain(ctx, top + SUB + ph + 44 + 24, ex);
}

function drawTime(ctx, r, y, ex) {
  const meta = r.meta;
  const st = r.stereo;
  const dy = r.dynamics;
  const top = section(ctx, y, t('sec.time'));
  const ph = 252;
  const w = (CW - 40) / 2;
  const dur = Math.max(meta.duration, 1);

  sub(ctx, M, top, t('time.corr'), t('time.corrSub'), w);
  const cp = { x: M, y: top + SUB, w, h: ph };
  panel(ctx, cp.x, cp.y, cp.w, cp.h);
  if (st.corrSeries.some((p) => p.v !== null)) {
    drawSeries(ctx, inset(cp), st.corrSeries, dur, { yMin: -1, yMax: 1, step: 0.5, tick: (v) => fmt(v, 1), color: THEME.accent });
  } else noData(ctx, cp, t('report.noData'));

  const x2 = M + w + 40;
  sub(ctx, x2, top, t('time.crest'), t('time.crestSub'), w);
  const kp = { x: x2, y: top + SUB, w, h: ph };
  panel(ctx, kp.x, kp.y, kp.w, kp.h);
  if (dy.crestSeries.some((p) => p.v !== null)) {
    const vals = dy.crestSeries.map((p) => p.v).filter((v) => v !== null);
    const [yMin, yMax] = niceRange(Math.min(...vals) - 1, Math.max(...vals) + 1, 5, 10);
    drawSeries(ctx, inset(kp), dy.crestSeries, dur, {
      yMin: Math.max(0, yMin), yMax, step: 5, tick: (v) => fmt(v, 0), color: THEME.accent, meanLine: dy.crestMean, meanLabel: t('time.mean'),
    });
  } else noData(ctx, kp, t('report.noData'));

  drawExplain(ctx, top + SUB + ph + 24, ex);
}

function drawFooter(ctx, y, warnings) {
  rule(ctx, y, 3);
  let ty = y + 40;
  for (const w of warnings) {
    ctx.fillStyle = THEME.accent2;
    ctx.fillRect(M, ty - 14, 12, 12);
    text(ctx, w, M + 24, ty, { size: 18, weight: 600, color: THEME.warn, maxWidth: CW - 24 });
    ty += 30;
  }
  text(ctx, t('footer.notice'), M, ty + 6, { size: 21, weight: 700, maxWidth: CW });
  text(ctx, t('footer.app'), M, ty + 40, { size: 16, color: THEME.muted, maxWidth: CW });
}

function shortHz(f) {
  return f >= 1000 ? `${f / 1000}k` : String(f);
}
