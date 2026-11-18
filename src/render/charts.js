// Canvas 2D の簡易チャート群。画面表示とPNG出力で同じ描画コードを使う。
// ctx は CanvasRenderingContext2D / OffscreenCanvasRenderingContext2D のどちらでもよい。

// 配色は「計測シート」: 冷たいグレーの方眼紙に、藍墨のインクと群青のデータ線、蛍光ピンクの目印。
// ピンクは図形（基準線・平均線・目印）専用。小さい文字には使わない（紙に対するコントラストが足りない）。
export const THEME = {
  bg: '#e9ecef', // 紙
  card: '#fbfcfd', // 図を載せる白いシート
  cardBorder: '#c5ccd6',
  text: '#1a1e4a', // 藍墨
  muted: '#566078',
  grid: '#d5dae2',
  gridMajor: '#c3cad6',
  axis: '#7d879c',
  accent: '#2f3dff', // 群青（データ）
  accentSoft: 'rgba(47,61,255,0.14)',
  accent2: '#ff4d8d', // 蛍光ピンク（基準線・目印）
  accent3: '#1a1e4a', // 第2の系列は墨
  warn: '#b8104f', // 注意書き（ピンクを文字で読める濃さに）
};

// Archivo（同梱の可変フォント。幅と太さの軸を使う）→ 日本語はシステムフォント。
export const FONT_FAMILY =
  '"Archivo","Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Meiryo UI","Noto Sans JP","Noto Sans CJK JP",system-ui,"Segoe UI",sans-serif';

/** stretch: CSSの font-stretch キーワード（condensed / normal / expanded など。Archivoは62〜125%に対応）。 */
export const font = (size, weight = 400, stretch = 'normal') => `${weight} ${stretch} ${size}px ${FONT_FAMILY}`;

/** キャンバスで使う字形を先に読み込む（読み込み前に描くと代替フォントで描かれてしまう）。 */
export async function ensureFonts() {
  if (!globalThis.document || !document.fonts) return;
  const probe = 'MIX0123456789dB';
  try {
    await Promise.all([
      document.fonts.load(font(40, 800, 'expanded'), probe),
      document.fonts.load(font(40, 700, 'condensed'), probe),
      document.fonts.load(font(20, 400), probe),
      document.fonts.load(font(20, 700), probe),
    ]);
  } catch { /* 読み込めなくても代替フォントで描ける */ }
}

const MINUS = '-'; // U+2212 はフォントによって字間が広く見えるのでASCIIのハイフンを使う

/** 数値の文字列化。null/NaN/±Infinity は「—」。 */
export function fmt(v, digits = 1) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = v.toFixed(digits);
  return (Number(s) === 0 ? s.replace('-', '') : s).replace('-', MINUS);
}

export function fmtSigned(v, digits = 1) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = fmt(v, digits);
  return v > 0 && s !== fmt(0, digits) ? '+' + s : s;
}

export function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtHz(fc) {
  if (fc >= 950) return `${Math.round(fc / 1000)}k`;
  if (fc < 45) return '31.5';
  if (fc < 100) return '63';
  return String(Math.round(fc));
}

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function text(ctx, s, x, y, o = {}) {
  const { size = 20, weight = 400, stretch = 'normal', color = THEME.text, align = 'left', baseline = 'alphabetic', maxWidth } = o;
  ctx.font = font(size, weight, stretch);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (maxWidth) s = fitText(ctx, s, maxWidth);
  ctx.fillText(s, x, y);
}

/** 幅に収まるよう末尾を「…」で省略（ctx.font は設定済みであること）。 */
export function fitText(ctx, s, maxWidth) {
  if (ctx.measureText(s).width <= maxWidth) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid) + '…').width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + '…';
}

/** 折り返した行の配列を返す（空白があればそこで、なければ文字単位）。 */
export function wrapLines(ctx, s, maxWidth, size, weight = 400) {
  ctx.font = font(size, weight);
  const lines = [];
  let cur = '';
  const NO_LINE_START = '、。，．,.）)」』】〕！？!?:：;；%'; // 行頭に来てはいけない文字は前の行にぶら下げる
  for (const ch of s) {
    if (NO_LINE_START.includes(ch) && cur) {
      cur += ch;
      continue;
    }
    if (ctx.measureText(cur + ch).width > maxWidth && cur) {
      // 英単語の途中で溢れたときだけ、直前の空白で折る（日本語の文中の空白では折らない）
      const sp = cur.lastIndexOf(' ');
      if (sp > cur.length * 0.4 && /[A-Za-z0-9]/.test(ch) && /[A-Za-z0-9]$/.test(cur)) {
        lines.push(cur.slice(0, sp));
        cur = cur.slice(sp + 1) + ch;
      } else {
        lines.push(cur);
        cur = ch === ' ' ? '' : ch;
      }
    } else cur += ch;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** グラフの枠・横罫線・y軸ラベルを描き、座標変換を返す。 */
function frame(ctx, rect, o) {
  const { yMin, yMax, step, tick = (v) => fmt(v, 0), left = 56, right = 10, top = 10, bottom = 34 } = o;
  const x0 = rect.x + left;
  const x1 = rect.x + rect.w - right;
  const y0 = rect.y + rect.h - bottom; // 下端
  const y1 = rect.y + top; // 上端
  const yOf = (v) => y0 - ((Math.min(yMax, Math.max(yMin, v)) - yMin) / (yMax - yMin)) * (y0 - y1);
  ctx.lineWidth = 1;
  for (let v = yMin; v <= yMax + 1e-9; v += step) {
    const y = Math.round(yOf(v)) + 0.5;
    ctx.strokeStyle = Math.abs(v) < 1e-9 ? THEME.axis : THEME.grid;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    text(ctx, tick(v), x0 - 8, y, { size: 15, color: THEME.muted, align: 'right', baseline: 'middle' });
  }
  return { x0, x1, y0, y1, yOf };
}

export function niceRange(min, max, step, minSpan = step * 2) {
  let lo = Math.floor(min / step) * step;
  let hi = Math.ceil(max / step) * step;
  if (hi - lo < minSpan) hi = lo + minSpan;
  return [lo, hi];
}

export function noData(ctx, rect, label) {
  text(ctx, label, rect.x + rect.w / 2, rect.y + rect.h / 2, { size: 20, color: THEME.muted, align: 'center', baseline: 'middle' });
}

/**
 * 帯域ごとの棒グラフ（0を基準に上下へ伸びる）。
 * items: [{label:string, v:number|null}]。label が空でなければ x 軸に表示。
 */
export function drawBandBars(ctx, rect, items, o) {
  const f = frame(ctx, rect, o);
  const n = items.length;
  const slot = (f.x1 - f.x0) / n;
  const zeroY = f.yOf(Math.min(Math.max(0, o.yMin), o.yMax));
  // 帯域名(zones)の区切り線: x位置は「1/3オクターブ帯域の連続した番号」から求める
  const zoneU = (fHz) => 3 * Math.log2(fHz / 1000) - o.k0 + 0.5;
  if (o.zones) {
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = THEME.gridMajor;
    ctx.lineWidth = 1;
    o.zones.slice(0, -1).forEach((z) => {
      const x = Math.round(f.x0 + slot * zoneU(z.hi)) + 0.5;
      if (x > f.x0 && x < f.x1) {
        ctx.beginPath();
        ctx.moveTo(x, f.y1);
        ctx.lineTo(x, f.y0);
        ctx.stroke();
      }
    });
    ctx.restore();
  }
  items.forEach((it, i) => {
    const cx = f.x0 + slot * (i + 0.5);
    if (it.v !== null && Number.isFinite(it.v)) {
      ctx.fillStyle = o.color || THEME.accent; // text() が fillStyle を変えるので毎回設定する
      const y = f.yOf(it.v);
      const bw = Math.max(2, slot * 0.68);
      ctx.fillRect(cx - bw / 2, Math.min(y, zeroY), bw, Math.max(1, Math.abs(y - zeroY)));
    }
    if (it.label) {
      text(ctx, it.label, cx, f.y0 + 22, { size: 15, color: THEME.muted, align: 'center' });
    }
  });
  if (o.refLine !== undefined) {
    const y = Math.round(f.yOf(o.refLine)) + 0.5;
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = THEME.accent2;
    ctx.beginPath();
    ctx.moveTo(f.x0, y);
    ctx.lineTo(f.x1, y);
    ctx.stroke();
    ctx.restore();
  }
  if (o.zones) {
    // 軸の下に、帯域名を括弧で示す
    const yb = f.y0 + 38;
    o.zones.forEach((z) => {
      const xa = f.x0 + slot * Math.max(0, zoneU(z.lo));
      const xb = f.x0 + slot * Math.min(n, zoneU(z.hi));
      if (xb - xa < 8) return;
      ctx.strokeStyle = THEME.axis;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xa + 3, yb - 5);
      ctx.lineTo(xa + 3, yb);
      ctx.lineTo(xb - 3, yb);
      ctx.lineTo(xb - 3, yb - 5);
      ctx.stroke();
      text(ctx, z.label, (xa + xb) / 2, yb + 18, { size: 14.5, weight: 500, color: THEME.muted, align: 'center' });
    });
  }
  return f;
}

/** 帯域ごとの折れ線（値が null の点は線を切る）。 */
export function drawBandLine(ctx, rect, items, o) {
  const f = frame(ctx, rect, o);
  const n = items.length;
  const slot = (f.x1 - f.x0) / n;
  ctx.strokeStyle = o.color || THEME.accent3;
  ctx.fillStyle = o.color || THEME.accent3;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  let pen = false;
  ctx.beginPath();
  items.forEach((it, i) => {
    const cx = f.x0 + slot * (i + 0.5);
    if (it.v === null || !Number.isFinite(it.v)) { pen = false; return; }
    const y = f.yOf(it.v);
    if (!pen) { ctx.moveTo(cx, y); pen = true; } else ctx.lineTo(cx, y);
  });
  ctx.stroke();
  items.forEach((it, i) => {
    const cx = f.x0 + slot * (i + 0.5);
    if (it.v !== null && Number.isFinite(it.v)) {
      ctx.beginPath();
      ctx.arc(cx, f.yOf(it.v), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (it.label) text(ctx, it.label, cx, f.y0 + 22, { size: 15, color: THEME.muted, align: 'center' });
  });
  return f;
}

/** 時間推移の折れ線。pts: [{t, v|null}]。meanLine を渡すと破線で平均を引く。 */
export function drawSeries(ctx, rect, pts, duration, o) {
  const f = frame(ctx, rect, { ...o, left: 56 });
  const xOf = (t) => f.x0 + (t / duration) * (f.x1 - f.x0);
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
  const tickStep = steps.find((s) => duration / s <= 8) || 1800;
  for (let t = 0; t <= duration + 1e-9; t += tickStep) {
    const x = xOf(t);
    text(ctx, fmtTime(t), x, f.y0 + 22, { size: 15, color: THEME.muted, align: t === 0 ? 'left' : 'center' });
  }
  ctx.strokeStyle = o.color || THEME.accent;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let pen = false;
  for (const p of pts) {
    if (p.v === null) { pen = false; continue; }
    const x = xOf(p.t);
    const y = f.yOf(p.v);
    if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // 1点だけの区間（前後がnull）も見えるように点を打つ
  ctx.fillStyle = o.color || THEME.accent;
  pts.forEach((p, i) => {
    if (p.v === null) return;
    const prev = pts[i - 1];
    const next = pts[i + 1];
    if ((!prev || prev.v === null) && (!next || next.v === null)) {
      ctx.beginPath();
      ctx.arc(xOf(p.t), f.yOf(p.v), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  if (o.meanLine !== undefined && o.meanLine !== null) {
    const y = Math.round(f.yOf(o.meanLine)) + 0.5;
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = THEME.accent2;
    ctx.beginPath();
    ctx.moveTo(f.x0, y);
    ctx.lineTo(f.x1, y);
    ctx.stroke();
    ctx.restore();
    text(ctx, `${o.meanLabel} ${fmt(o.meanLine, 1)}`, f.x1, y - 6, { size: 15, weight: 600, color: THEME.warn, align: 'right' });
  }
  return f;
}

/** 横棒（7帯域のエネルギー比など）。items: [{label, sub, v(0〜100)|null}]。 */
export function drawHBars(ctx, rect, items, o = {}) {
  const n = items.length;
  const rowH = rect.h / n;
  const labelW = o.labelW || 150;
  const valueW = 78;
  const barX = rect.x + labelW;
  const barW = rect.w - labelW - valueW;
  const vmax = o.max || Math.max(10, ...items.map((it) => (it.v === null ? 0 : it.v)));
  items.forEach((it, i) => {
    const cy = rect.y + rowH * (i + 0.5);
    text(ctx, it.label, rect.x, cy - 6, { size: 17, weight: 600, baseline: 'middle', maxWidth: labelW - 8 });
    text(ctx, it.sub, rect.x, cy + 14, { size: 14, color: THEME.muted, baseline: 'middle', maxWidth: labelW - 8 });
    ctx.fillStyle = THEME.grid;
    roundRect(ctx, barX, cy - 12, barW, 24, 6);
    ctx.fill();
    if (it.v !== null) {
      ctx.fillStyle = THEME.accent;
      roundRect(ctx, barX, cy - 12, Math.max(5, (it.v / vmax) * barW), 24, 6);
      ctx.fill();
    }
    text(ctx, it.v === null ? '—' : `${fmt(it.v, 1)}%`, rect.x + rect.w, cy, { size: 18, weight: 600, align: 'right', baseline: 'middle' });
  });
}

/** ゴニオメーター（散布図）。xy = [x0,y0,x1,y1,...]。最大値で正規化して描く。 */
export function drawGoniometer(ctx, rect, xy, labels) {
  const size = Math.min(rect.w, rect.h);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const half = size / 2 - 22;
  ctx.save();
  ctx.fillStyle = THEME.card;
  ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
  ctx.strokeStyle = THEME.cardBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - size / 2 + 0.5, cy - size / 2 + 0.5, size - 1, size - 1);
  ctx.strokeStyle = THEME.grid;
  ctx.lineWidth = 1;
  // 円・十字・L/R の対角線
  ctx.beginPath();
  ctx.arc(cx, cy, half, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, half / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - half, cy); ctx.lineTo(cx + half, cy);
  ctx.moveTo(cx, cy - half); ctx.lineTo(cx, cy + half);
  ctx.moveTo(cx - half * 0.7071, cy + half * 0.7071); ctx.lineTo(cx + half * 0.7071, cy - half * 0.7071);
  ctx.moveTo(cx - half * 0.7071, cy - half * 0.7071); ctx.lineTo(cx + half * 0.7071, cy + half * 0.7071);
  ctx.stroke();
  const lab = { size: 15, color: THEME.muted, align: 'center', baseline: 'middle' };
  text(ctx, labels.mid, cx, cy - half - 11, lab);
  // x=(L−R)/√2 なので、Lのみの信号は右上、Rのみは左上の対角線上に出る
  text(ctx, labels.ul, cx - half * 0.7071 - 14, cy - half * 0.7071 - 8, lab);
  text(ctx, labels.ur, cx + half * 0.7071 + 14, cy - half * 0.7071 - 8, lab);
  text(ctx, labels.side, cx + half + 12, cy, { ...lab, align: 'left' });

  const n = xy.length / 2;
  if (n > 0) {
    let m = 0;
    for (let i = 0; i < xy.length; i++) {
      const a = Math.abs(xy[i]);
      if (a > m) m = a;
    }
    if (m > 0) {
      const k = (half * 0.98) / m;
      ctx.globalCompositeOperation = 'multiply'; // 白いシートの上で、重なった点ほど濃くなる
      ctx.fillStyle = 'rgba(47,61,255,0.2)';
      for (let i = 0; i < n; i++) {
        ctx.fillRect(cx + xy[i * 2] * k - 0.9, cy - xy[i * 2 + 1] * k - 0.9, 1.8, 1.8);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }
  ctx.restore();
}
