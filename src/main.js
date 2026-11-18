// 画面の制御: ファイル入力 → Worker解析（進捗表示）→ 結果画像の表示・保存・共有。
import { detectLocale, setLocale, applyDom, t, getLocale } from './i18n/index.js';
import { renderReport, getWarnings, summarize } from './render/report.js';
import { ensureFonts, fmtHz } from './render/charts.js';
import { looksLikeWav } from './decode/wav.js';
import { scoreResult } from './score/score.js';
import { buildReadings, formatReading } from './explain/readings.js';
import { GLOSSARY_GROUPS, CHART_GUIDES } from './explain/glossary.js';
import { PRESETS, DEFAULT_PRESET } from './score/criteria.js';
import { decodeWithWebAudio, DecodeError } from './decode/webaudio.js';

setLocale(detectLocale());
applyDom();

const $ = (id) => document.getElementById(id);
const el = {
  drop: $('drop'), pick: $('pick'), file: $('file'),
  busy: $('busy'), busyText: $('busy-text'), bar: $('bar'), cancel: $('cancel'),
  error: $('error'), result: $('result'), report: $('report'), scroller: $('scroller'),
  warnings: $('warnings'), preset: $('preset'), save: $('save'), share: $('share'), zoom: $('zoom'), again: $('again'),
};

const CHUNK_FRAMES = 131072;
const MAX_IN_FLIGHT = 3;

class AppError extends Error {
  constructor(code) { super(code); this.code = code; }
}

let job = null; // 実行中: { worker, cancelled }
let lastResult = null;
let pngBlob = null;
let pngName = 'mix-analysis.png';

// ---------- 画面状態 ----------
function show(state) {
  document.body.dataset.state = state; // CSSが見出しの大きさなどを切り替える
  el.drop.hidden = state !== 'idle';
  el.busy.hidden = state !== 'busy';
  el.result.hidden = state !== 'result';
}
function showError(code) {
  const map = {
    EMPTY: 'error.empty', TRUNCATED: 'error.truncated', 'decode-failed': 'error.decode',
    'no-webaudio': 'error.noaudio', worker: 'error.worker',
  };
  el.error.textContent = t(map[code] || 'error.generic');
  el.error.hidden = false;
}
function clearError() { el.error.hidden = true; el.error.textContent = ''; }

function setStage(stage, ratio) {
  el.busyText.textContent = t('progress.' + stage);
  if (ratio === null || ratio === undefined) el.bar.removeAttribute('value');
  else el.bar.value = ratio;
}

// ---------- ドロップ欄の周波数ルーラー（1/3オクターブの目盛り。20Hz〜20kHz） ----------
function buildRuler(root) {
  const lo = Math.log10(20);
  const span = Math.log10(20000) - lo;
  const pos = (f) => ((Math.log10(f) - lo) / span) * 100;
  const frag = document.createDocumentFragment();
  const add = (cls, left, txt) => {
    const e = document.createElement('i');
    e.className = cls;
    if (left !== undefined) e.style.left = left + '%';
    if (txt) e.textContent = txt;
    frag.append(e);
  };
  add('ref');
  add('base');
  for (let k = -16; k <= 14; k++) {
    const fc = 1000 * Math.pow(2, k / 3);
    if (fc < 20 || fc > 20000) continue;
    const oct = ((k % 3) + 3) % 3 === 0;
    add(oct ? 'tick oct' : 'tick', pos(fc));
    if (oct && fc >= 30) add('lab', pos(fc), fmtHz(fc));
  }
  root.replaceChildren(frag);
}
buildRuler($('ruler'));

// ---------- 解析 ----------
function startWorker() {
  try {
    return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch {
    throw new AppError('worker');
  }
}

/** WAVをWorkerに渡して解析。自前で読めない形式なら null を返す。 */
function analyzeWavInWorker(j, file) {
  return new Promise((resolve, reject) => {
    const worker = startWorker();
    j.worker = worker;
    j.abort = () => reject(new AppError('cancelled'));
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') setStage(m.stage, m.ratio);
      else if (m.type === 'result') { worker.terminate(); resolve(m.result); }
      else if (m.type === 'unsupported') { worker.terminate(); resolve(null); }
      else if (m.type === 'error') { worker.terminate(); reject(new AppError(m.code)); }
    };
    worker.onerror = () => { worker.terminate(); reject(new AppError('worker')); };
    worker.postMessage({ type: 'startFile', file });
  });
}

/** メインスレッドでデコードし、Float32の塊をWorkerへ流して解析（受け取りを確認しながら送る）。 */
async function analyzeDecodedInWorker(j, file) {
  setStage('decode', null);
  const dec = await decodeWithWebAudio(file);
  if (j.cancelled) throw new AppError('cancelled');
  const buf = dec.buffer;
  const total = buf.length;
  if (total === 0) throw new AppError('EMPTY');
  const isMono = buf.numberOfChannels === 1;

  return new Promise((resolve, reject) => {
    const worker = startWorker();
    j.worker = worker;
    j.abort = () => reject(new AppError('cancelled'));
    let offset = 0;
    let inFlight = 0;
    let started = false;
    let ended = false;

    const pump = () => {
      while (inFlight < MAX_IN_FLIGHT && offset < total) {
        const n = Math.min(CHUNK_FRAMES, total - offset);
        const L = new Float32Array(n);
        buf.copyFromChannel(L, 0, offset);
        const msg = { type: 'chunk', L, isMono };
        const transfer = [L.buffer];
        if (!isMono) {
          const R = new Float32Array(n);
          buf.copyFromChannel(R, 1, offset);
          msg.R = R;
          transfer.push(R.buffer);
        }
        worker.postMessage(msg, transfer);
        offset += n;
        inFlight++;
      }
      if (offset >= total && inFlight === 0 && !ended) {
        ended = true;
        worker.postMessage({ type: 'end' });
      }
    };

    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'ack') {
        if (!started) started = true; else inFlight--;
        pump();
      } else if (m.type === 'progress') setStage(m.stage, m.ratio);
      else if (m.type === 'result') { worker.terminate(); resolve(m.result); }
      else if (m.type === 'error') { worker.terminate(); reject(new AppError(m.code)); }
    };
    worker.onerror = () => { worker.terminate(); reject(new AppError('worker')); };
    worker.postMessage({
      type: 'startStream',
      sampleRate: dec.sampleRate,
      totalFrames: total,
      isMono,
      meta: {
        decoder: 'webaudio',
        format: (dec.format || 'audio').toUpperCase(),
        sourceChannels: dec.channels,
        sourceSampleRate: dec.sourceRate || dec.sampleRate,
        resampled: dec.resampled,
        rateUnknown: dec.rateUnknown,
      },
    });
  });
}

async function analyze(file) {
  if (job) return;
  clearError();
  const j = { worker: null, cancelled: false, abort: null };
  job = j;
  show('busy');
  setStage('read', null);
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    let result = null;
    if (looksLikeWav(head)) result = await analyzeWavInWorker(j, file);
    if (!result) result = await analyzeDecodedInWorker(j, file);
    if (j.cancelled) throw new AppError('cancelled');
    result.meta.fileName = file.name;
    await showResult(result, file.name);
  } catch (e) {
    if (j.cancelled || (e && e.code === 'cancelled')) {
      // 中止: 画面は cancel ボタン側で戻している
    } else {
      show('idle');
      showError(e instanceof DecodeError ? e.message : e && e.code);
    }
  } finally {
    if (job === j) job = null;
    el.file.value = '';
  }
}

// ---------- 採点基準（ラウドネスのプリセット） ----------
const PRESET_KEY = 'mixAnalyzer.preset';
let presetId = DEFAULT_PRESET;
try {
  const saved = localStorage.getItem(PRESET_KEY);
  if (saved && PRESETS[saved]) presetId = saved;
} catch { /* 保存できなくても動く */ }

el.preset.replaceChildren(
  ...Object.keys(PRESETS).map((id) => Object.assign(document.createElement('option'), { value: id, textContent: t('score.preset.' + id) })),
);
el.preset.value = presetId;

el.preset.addEventListener('change', async () => {
  presetId = el.preset.value;
  try { localStorage.setItem(PRESET_KEY, presetId); } catch { /* ignore */ }
  if (lastResult) await draw(); // 再解析は不要。結果JSONから採点し直して描き直すだけ
});

// ---------- 指標の見方（画面の説明。画像の内容と同じ文言を、開閉できる形で出す） ----------
const h = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined));
  return e;
};

function renderGuide(result) {
  // 今回の読み取り（文章はコピーしやすいようにDOMにも出す）
  const rd = buildReadings(result);
  const groups = [
    ['gg.loudness', rd.loudness],
    ['sec.freq', rd.freq],
    ['sec.stereo', rd.stereo],
    ['sec.time', rd.time],
  ];
  const reading = h('div');
  reading.append(h('h3', { textContent: t('gg.reading') }));
  for (const [titleKey, items] of groups) {
    if (items.length === 0) continue;
    reading.append(h('h4', { textContent: t(titleKey) }), h('ul', {}, ...items.map((r) => h('li', { textContent: formatReading(r) }))));
  }
  $('guide-reading').replaceChildren(reading);

  // 用語の説明（意味・目安）とグラフの見方
  const terms = [];
  for (const g of GLOSSARY_GROUPS) {
    terms.push(h('h3', { textContent: t('gg.' + g.id) }));
    for (const id of g.ids) {
      terms.push(h('details', { className: 'term' },
        h('summary', {}, h('span', { className: 'term-name', textContent: t('tile.' + id) }), h('span', { className: 'term-short', textContent: t(`g.${id}.short`) })),
        h('dl', {}, h('dt', { textContent: t('gg.what') }), h('dd', { textContent: t(`g.${id}.what`) }), h('dt', { textContent: t('gg.guide') }), h('dd', { textContent: t(`g.${id}.guide`) }))));
    }
  }
  terms.push(h('h3', { textContent: t('gg.charts') }));
  for (const id of CHART_GUIDES) {
    terms.push(h('details', { className: 'term' },
      h('summary', {}, h('span', { className: 'term-name', textContent: t(`how.${id}.head`) })),
      h('dl', {}, h('dd', { textContent: t(`how.${id}`) }))));
  }
  $('guide-terms').replaceChildren(...terms);
}

/** 結果JSONから画像を描き、PNGを作り直す（採点基準を変えたときも使う）。 */
async function draw() {
  const result = lastResult;
  await ensureFonts();
  const dateLabel = new Date().toLocaleDateString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
  renderReport(el.report, result, { dateLabel, score: scoreResult(result, presetId) });
  el.report.setAttribute('aria-label', summarize(result));
  renderGuide(result);
  pngBlob = await new Promise((res) => el.report.toBlob(res, 'image/png'));
  el.share.hidden = !canShare();
}

async function showResult(result, fileName) {
  lastResult = result;
  el.warnings.replaceChildren(...getWarnings(result).map((w) => Object.assign(document.createElement('li'), { textContent: w })));
  pngName = fileName.replace(/\.[^.]+$/, '') + '_mix-analysis.png';
  await draw();
  setZoom(false);
  show('result');
  el.result.scrollIntoView({ block: 'start' });
}

// ---------- 保存・共有 ----------
function canShare() {
  try {
    return !!(pngBlob && navigator.canShare && navigator.canShare({ files: [new File([pngBlob], pngName, { type: 'image/png' })] }));
  } catch { return false; }
}

el.save.addEventListener('click', () => {
  if (!pngBlob) return;
  const url = URL.createObjectURL(pngBlob);
  const a = Object.assign(document.createElement('a'), { href: url, download: pngName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

el.share.addEventListener('click', async () => {
  if (!pngBlob) return;
  try {
    await navigator.share({ files: [new File([pngBlob], pngName, { type: 'image/png' })], title: t('report.title') });
  } catch { /* キャンセルなど */ }
});

function setZoom(on) {
  el.scroller.classList.toggle('zoomed', on);
  el.zoom.textContent = t(on ? 'result.zoomOut' : 'result.zoomIn');
}
el.zoom.addEventListener('click', () => setZoom(!el.scroller.classList.contains('zoomed')));

el.again.addEventListener('click', () => {
  lastResult = null;
  pngBlob = null;
  clearError();
  show('idle');
});

el.cancel.addEventListener('click', () => {
  const j = job;
  if (!j) return;
  j.cancelled = true;
  job = null; // すぐ次のファイルを受け付ける（デコード中の処理は終わり次第捨てる）
  if (j.worker) j.worker.terminate();
  if (j.abort) j.abort();
  show('idle');
});

// ---------- ファイル入力 ----------
el.pick.addEventListener('click', () => el.file.click());
el.file.addEventListener('change', () => {
  const f = el.file.files && el.file.files[0];
  if (f) analyze(f);
});

let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (f) analyze(f);
});

// ---------- PWA ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* オフライン対応なしでも動作する */ });
  });
}

// テストや将来の拡張（スコア表示など）から参照するための入口
window.__mixAnalyzer = { analyze, get result() { return lastResult; }, get score() { return lastResult && scoreResult(lastResult, presetId); } };
