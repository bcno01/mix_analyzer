// テスト用の補助: 合成信号、WAVファイルの組み立て、ByteSource、解析の実行。
import { Analyzer } from '../src/dsp/pipeline.js';

export const approx = (actual, expected, tol, msg = '') => {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${msg} expected ${expected} ±${tol}, got ${actual}`);
  }
};

/** 先頭・末尾に短いフェードを付けたサイン波（始端の不連続によるオーバーシュートを避ける）。 */
export function sine(fs, seconds, freq, amp, phase = 0, fade = 0.02) {
  const n = Math.round(fs * seconds);
  const x = new Float64Array(n);
  const f = Math.round(fs * fade);
  for (let i = 0; i < n; i++) {
    const w = f > 0 ? Math.min(1, i / f, (n - 1 - i) / f) : 1;
    x[i] = w * amp * Math.sin(2 * Math.PI * freq * (i / fs) + phase);
  }
  return x;
}

export const dbToAmp = (db) => Math.pow(10, db / 20);

/** 簡単な擬似乱数（再現性のため）。 */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function whiteNoise(n, amp, seed = 1) {
  const r = rng(seed);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * (r() * 2 - 1);
  return x;
}

export function concat(...arrs) {
  const out = new Float64Array(arrs.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

/** L,R を一括で解析（ブロックに分けて流す）。R が null / L と同一ならモノラル扱い。 */
export function analyze(fs, L, R = null, chunk = 50000) {
  const mono = R === null || R === L;
  const right = mono ? L : R;
  const a = new Analyzer({ sampleRate: fs, totalFrames: L.length, isMono: mono, meta: {} });
  for (let o = 0; o < L.length; o += chunk) {
    const e = Math.min(L.length, o + chunk);
    a.push(L.subarray(o, e), right.subarray(o, e));
  }
  return a.finish();
}

/** WAV (RIFF) を組み立てる。channels: Float配列の配列（-1〜1）。 */
export function makeWav({ fs, channels, bits = 16, float = false, extensible = false, extraChunk = false, rf64 = false }) {
  const nch = channels.length;
  const frames = channels[0].length;
  const bytes = bits / 8;
  const blockAlign = nch * bytes;
  const dataBytes = frames * blockAlign;
  const fmtLen = extensible ? 40 : 16;
  const extra = extraChunk ? 8 + 6 : 0; // 奇数長のLISTを挟む（パディング込み）
  const total = 12 + (rf64 ? 8 + 28 : 0) + 8 + fmtLen + extra + 8 + dataBytes;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let p = 0;
  const str = (s) => { for (const c of s) u8[p++] = c.charCodeAt(0); };
  const u16 = (v) => { dv.setUint16(p, v, true); p += 2; };
  const u32 = (v) => { dv.setUint32(p, v, true); p += 4; };
  str(rf64 ? 'RF64' : 'RIFF'); u32(rf64 ? 0xffffffff : total - 8); str('WAVE');
  if (rf64) {
    str('ds64'); u32(28);
    dv.setBigUint64(p, BigInt(total - 8), true); p += 8;
    dv.setBigUint64(p, BigInt(dataBytes), true); p += 8;
    dv.setBigUint64(p, BigInt(frames), true); p += 8;
    u32(0);
  }
  str('fmt '); u32(fmtLen);
  u16(extensible ? 0xfffe : float ? 3 : 1); u16(nch); u32(fs); u32(fs * blockAlign); u16(blockAlign); u16(bits);
  if (extensible) {
    u16(22); u16(bits); u32(nch === 2 ? 3 : 4);
    u16(float ? 3 : 1); str('\x00\x00\x00\x00\x10\x00\x80\x00\x00\xaa\x00\x38\x9b\x71');
  }
  if (extraChunk) { str('LIST'); u32(5); str('abcde'); u8[p++] = 0; }
  str('data'); u32(rf64 ? 0xffffffff : dataBytes);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      if (float && bits === 32) { dv.setFloat32(p, v, true); p += 4; }
      else if (float && bits === 64) { dv.setFloat64(p, v, true); p += 8; }
      else if (bits === 8) { u8[p++] = Math.round(v * 127) + 128; }
      else if (bits === 16) { dv.setInt16(p, Math.round(v * 32767), true); p += 2; }
      else if (bits === 24) {
        const q = Math.round(v * 8388607);
        u8[p++] = q & 255; u8[p++] = (q >> 8) & 255; u8[p++] = (q >> 16) & 255;
      } else if (bits === 32) { dv.setInt32(p, Math.round(v * 2147483647), true); p += 4; }
    }
  }
  return buf;
}

export function bufferSource(buf) {
  return { size: buf.byteLength, read: async (s, e) => buf.slice(s, e) };
}
