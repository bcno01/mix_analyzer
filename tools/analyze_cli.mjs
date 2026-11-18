// コマンドラインでWAVを解析してJSONを出す（検証用）。ブラウザ版と同じ src/ のコードを使う。
// 使い方: node tools/analyze_cli.mjs <file.wav> [--full]
//   --full: 時間推移・ゴニオメーターも含めて出す（既定は要約のみ）
import { open } from 'node:fs/promises';
import { Analyzer } from '../src/dsp/pipeline.js';
import { parseWav, decodeFrames } from '../src/decode/wav.js';

const path = process.argv[2];
const full = process.argv.includes('--full');
if (!path) {
  console.error('usage: node tools/analyze_cli.mjs <file.wav> [--full]');
  process.exit(2);
}

const fh = await open(path, 'r');
const { size } = await fh.stat();
const src = {
  size,
  async read(start, end) {
    const buf = Buffer.alloc(end - start);
    const { bytesRead } = await fh.read(buf, 0, end - start, start);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead);
  },
};

const t0 = performance.now();
const info = await parseWav(src);
const mono = info.channels === 1;
const a = new Analyzer({ sampleRate: info.sampleRate, totalFrames: info.frames, isMono: mono, meta: { decoder: 'wav' } });
const CH = 65536;
const L = new Float64Array(CH);
const R = mono ? L : new Float64Array(CH);
const sink = mono ? new Float64Array(CH) : R;
for (let done = 0; done < info.frames; done += CH) {
  const n = Math.min(CH, info.frames - done);
  const s = info.dataOffset + done * info.blockAlign;
  decodeFrames(await src.read(s, s + n * info.blockAlign), info, n, L, sink);
  a.push(L, R, n);
}
const r = a.finish();
await fh.close();

const out = full
  ? r
  : {
      meta: r.meta,
      loudness: r.loudness,
      dynamics: { ...r.dynamics, crestSeries: undefined },
      spectrum: r.spectrum && { bands: r.spectrum.bands, seven: r.spectrum.seven },
      stereo: { ...r.stereo, corrSeries: undefined, goniometer: undefined },
    };
out.elapsedMs = Math.round(performance.now() - t0);
console.log(JSON.stringify(out, (k, v) => (v instanceof Float32Array ? Array.from(v) : v)));
