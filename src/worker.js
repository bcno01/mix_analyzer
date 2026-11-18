// 解析Worker。重いDSPはここで実行し、進捗をメインスレッドへ返す。
//
// メインスレッド → Worker
//   {type:'startFile', file}                       WAVを自前でパースして逐次解析
//   {type:'startStream', sampleRate, totalFrames, isMono, meta}   デコード済みデータを受け取る
//   {type:'chunk', L, R}                           （stream）Float32Array（転送）
//   {type:'end'}                                   （stream）終了
// Worker → メインスレッド
//   {type:'progress', stage, ratio}   ratio は 0〜1
//   {type:'ack'}                      （stream）chunk を処理し終えた
//   {type:'unsupported', reason}      WAVだが自前では読めない形式
//   {type:'result', result}
//   {type:'error', code, message}

import { Analyzer } from './dsp/pipeline.js';
import { parseWav, decodeFrames, fileSource, UnsupportedFormatError, describeWav } from './decode/wav.js';

const CHUNK_FRAMES = 65536;
let analyzer = null;
let streamFrames = 0;
let lastProgress = 0;

function progress(stage, ratio, force = false) {
  const now = performance.now();
  if (!force && now - lastProgress < 60) return;
  lastProgress = now;
  self.postMessage({ type: 'progress', stage, ratio });
}

function finish() {
  progress('finalize', 1, true);
  const result = analyzer.finish();
  self.postMessage({ type: 'result', result });
  analyzer = null;
}

async function analyzeFile(file) {
  const src = fileSource(file);
  let info;
  try {
    info = await parseWav(src);
  } catch (e) {
    if (e instanceof UnsupportedFormatError) {
      self.postMessage({ type: 'unsupported', reason: e.reason });
      return;
    }
    throw e;
  }
  if (info.frames === 0) throw Object.assign(new Error('EMPTY'), { code: 'EMPTY' });

  const isMono = info.channels === 1;
  analyzer = new Analyzer({
    sampleRate: info.sampleRate,
    totalFrames: info.frames,
    isMono,
    meta: {
      decoder: 'wav',
      format: describeWav(info),
      sourceChannels: info.channels,
      sourceSampleRate: info.sampleRate,
      resampled: false,
      rateUnknown: false,
    },
  });
  const L = new Float64Array(CHUNK_FRAMES);
  const R = isMono ? L : new Float64Array(CHUNK_FRAMES);
  const sink = isMono ? new Float64Array(CHUNK_FRAMES) : R; // モノラルのR出力は捨てる（L=Rとして扱う）
  let done = 0;
  while (done < info.frames) {
    const n = Math.min(CHUNK_FRAMES, info.frames - done);
    const start = info.dataOffset + done * info.blockAlign;
    const buf = await src.read(start, start + n * info.blockAlign);
    if (buf.byteLength < n * info.blockAlign) throw Object.assign(new Error('TRUNCATED'), { code: 'TRUNCATED' });
    decodeFrames(buf, info, n, L, sink);
    analyzer.push(L, R, n);
    done += n;
    progress('analyze', done / info.frames);
  }
  finish();
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'startFile') {
      await analyzeFile(m.file);
    } else if (m.type === 'startStream') {
      analyzer = new Analyzer({
        sampleRate: m.sampleRate,
        totalFrames: m.totalFrames,
        isMono: m.isMono,
        meta: m.meta,
      });
      streamFrames = 0;
      self.postMessage({ type: 'ack' });
    } else if (m.type === 'chunk') {
      const n = m.L.length;
      analyzer.push(m.L, m.isMono ? m.L : m.R, n);
      streamFrames += n;
      progress('analyze', Math.min(1, streamFrames / analyzer.totalFrames));
      self.postMessage({ type: 'ack' });
    } else if (m.type === 'end') {
      finish();
    }
  } catch (e) {
    self.postMessage({ type: 'error', code: e.code || e.message, message: String(e && e.message) });
  }
};
