import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWav, decodeFrames, looksLikeWav, UnsupportedFormatError } from '../src/decode/wav.js';
import { sniffSampleRate } from '../src/decode/sniff.js';
import { approx, sine, makeWav, bufferSource, analyze, dbToAmp } from './helpers.js';

async function roundTrip(opts) {
  const buf = makeWav(opts);
  const info = await parseWav(bufferSource(buf));
  const n = info.frames;
  const bytes = buf.slice(info.dataOffset, info.dataOffset + info.dataBytes);
  const L = new Float64Array(n);
  const R = new Float64Array(n);
  decodeFrames(bytes, info, n, L, R);
  return { info, L, R };
}

const FORMATS = [
  { bits: 8, float: false },
  { bits: 16, float: false },
  { bits: 24, float: false },
  { bits: 32, float: false },
  { bits: 32, float: true },
  { bits: 64, float: true },
];

test('WAV: 44.1k/48k/96k × 8/16/24/32bit/float32/float64 × モノ/ステレオ をパースして値が戻る', async () => {
  for (const fs of [44100, 48000, 96000]) {
    for (const f of FORMATS) {
      for (const nch of [1, 2]) {
        const a = sine(fs, 0.05, 997, 0.5);
        const b = sine(fs, 0.05, 1500, 0.25);
        const channels = nch === 1 ? [a] : [a, b];
        const { info, L, R } = await roundTrip({ fs, channels, ...f });
        const tag = `fs=${fs} bits=${f.bits} float=${f.float} ch=${nch}`;
        assert.equal(info.sampleRate, fs, tag);
        assert.equal(info.channels, nch, tag);
        assert.equal(info.frames, a.length, tag);
        const tol = f.bits === 8 ? 0.01 : f.bits === 16 ? 1e-4 : 1e-6;
        for (let i = 0; i < a.length; i += 7) {
          approx(L[i], a[i], tol, tag);
          approx(R[i], nch === 1 ? a[i] : b[i], tol, tag); // モノラルは L=R
        }
      }
    }
  }
});

test('WAV: 3ch以上は先頭2chだけを使う', async () => {
  const fs = 48000;
  const c = [sine(fs, 0.05, 440, 0.5), sine(fs, 0.05, 880, 0.3), sine(fs, 0.05, 1200, 0.9), sine(fs, 0.05, 50, 0.9)];
  const { info, L, R } = await roundTrip({ fs, channels: c, bits: 24 });
  assert.equal(info.channels, 4);
  for (let i = 0; i < L.length; i += 5) {
    approx(L[i], c[0][i], 1e-6);
    approx(R[i], c[1][i], 1e-6);
  }
});

test('WAV: WAVE_FORMAT_EXTENSIBLE・奇数長の追加チャンク・RF64', async () => {
  const fs = 48000;
  const a = sine(fs, 0.05, 440, 0.5);
  for (const extra of [{ extensible: true }, { extraChunk: true }, { rf64: true }, { extensible: true, extraChunk: true, rf64: true }]) {
    for (const f of [{ bits: 24, float: false }, { bits: 32, float: true }]) {
      const { info, L } = await roundTrip({ fs, channels: [a, a], ...f, ...extra });
      assert.equal(info.frames, a.length, JSON.stringify(extra));
      approx(L[100], a[100], 1e-6);
    }
  }
});

test('WAV: データ長が実ファイルより長い（途中で切れた/ストリーム書き出し）場合は残りを使う', async () => {
  const fs = 48000;
  const a = sine(fs, 0.1, 440, 0.5);
  const buf = makeWav({ fs, channels: [a, a], bits: 16 });
  const cut = buf.slice(0, buf.byteLength - 1001); // 端数バイトも含めて切る
  const info = await parseWav(bufferSource(cut));
  const expectFrames = Math.floor((cut.byteLength - info.dataOffset) / 4);
  assert.equal(info.frames, expectFrames);
});

test('WAV: 非対応コーデックは UnsupportedFormatError（呼び出し側でWebAudioに回す）', async () => {
  const fs = 48000;
  const buf = makeWav({ fs, channels: [sine(fs, 0.05, 440, 0.5)], bits: 16 });
  new DataView(buf).setUint16(20, 6, true); // A-law
  await assert.rejects(parseWav(bufferSource(buf)), UnsupportedFormatError);
  await assert.rejects(parseWav(bufferSource(new ArrayBuffer(100))), UnsupportedFormatError);
});

test('WAV: looksLikeWav', () => {
  const b = new Uint8Array(makeWav({ fs: 48000, channels: [new Float64Array(10)], bits: 16 }), 0, 12);
  assert.equal(looksLikeWav(b), true);
  assert.equal(looksLikeWav(new Uint8Array(12)), false);
});

test('WAV→解析: 24bit/32bit float のWAVでも 1kHz -20dBFS が -20.0 LUFS ±0.1', async () => {
  for (const f of [{ bits: 24, float: false }, { bits: 32, float: true }, { bits: 16, float: false }]) {
    const fs = 44100;
    const x = sine(fs, 12, 1000, dbToAmp(-20));
    const { L, R, info } = await roundTrip({ fs, channels: [x, x], ...f });
    assert.equal(info.sampleRate, 44100);
    const r = analyze(fs, L, R);
    approx(r.loudness.integrated, -20, 0.1, JSON.stringify(f));
  }
});

// ---- 圧縮形式のヘッダからレートを読む ----
const src = (bytes) => bufferSource(Uint8Array.from(bytes).buffer);

test('sniff: MP3（ID3v2タグあり/なし、MPEG-1/2）', async () => {
  const hdr = (ver, idx) => [0xff, 0xe0 | (ver << 3) | (1 << 1) | 1, (9 << 4) | (idx << 2), 0x00];
  const pad = new Array(64).fill(0);
  assert.equal((await sniffSampleRate(src([...hdr(3, 0), ...pad]))).rate, 44100);
  assert.equal((await sniffSampleRate(src([...hdr(3, 1), ...pad]))).rate, 48000);
  assert.equal((await sniffSampleRate(src([...hdr(2, 0), ...pad]))).rate, 22050);
  const id3 = [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20, ...new Array(20).fill(0)];
  const r = await sniffSampleRate(src([...id3, ...hdr(3, 1), ...pad]));
  assert.deepEqual([r.kind, r.rate], ['mp3', 48000]);
});

test('sniff: FLAC STREAMINFO のサンプルレート', async () => {
  const mk = (rate) => {
    const b = new Array(64).fill(0);
    b.splice(0, 4, 0x66, 0x4c, 0x61, 0x43);
    b[18] = (rate >> 12) & 0xff;
    b[19] = (rate >> 4) & 0xff;
    b[20] = (rate & 0xf) << 4;
    return b;
  };
  for (const rate of [44100, 48000, 96000, 192000]) {
    const r = await sniffSampleRate(src(mk(rate)));
    assert.deepEqual([r.kind, r.rate], ['flac', rate]);
  }
});

test('sniff: ADTS(AAC)・Ogg Vorbis/Opus', async () => {
  const adts = [0xff, 0xf1, (1 << 6) | (3 << 2), 0x80, ...new Array(64).fill(0)]; // index 3 = 48000
  assert.deepEqual(Object.values(await sniffSampleRate(src(adts))), ['aac', 48000]);

  const enc = (s) => Array.from(s, (c) => c.charCodeAt(0));
  const vorbis = [...enc('OggS'), ...new Array(23).fill(0), ...enc('\x01vorbis'), 0, 0, 0, 0, 2, 0x44, 0xac, 0, 0, ...new Array(30).fill(0)];
  const v = await sniffSampleRate(src(vorbis));
  assert.deepEqual([v.kind, v.rate], ['vorbis', 44100]);
  const opus = [...enc('OggS'), ...new Array(23).fill(0), ...enc('OpusHead'), ...new Array(30).fill(0)];
  assert.equal((await sniffSampleRate(src(opus))).rate, 48000);
});

test('sniff: MP4/M4A は moov が後ろにあっても mdhd のタイムスケールを読む', async () => {
  const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const tag = (s) => Array.from(s, (c) => c.charCodeAt(0));
  const box = (type, ...payload) => {
    const body = payload.flat();
    return [...be32(8 + body.length), ...tag(type), ...body];
  };
  const mdhd = box('mdhd', 0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(44100), ...be32(0), 0, 0, 0, 0);
  const hdlr = box('hdlr', 0, 0, 0, 0, ...be32(0), ...tag('soun'), ...new Array(12).fill(0), 0);
  const trak = box('trak', box('mdia', mdhd, hdlr));
  const moov = box('moov', trak);
  const ftyp = box('ftyp', ...tag('M4A '), ...be32(0), ...tag('M4A '));
  const mdat = box('mdat', ...new Array(100).fill(1));
  const r = await sniffSampleRate(src([...ftyp, ...mdat, ...moov]));
  assert.deepEqual([r.kind, r.rate], ['mp4', 44100]);
});

test('sniff: 判別できないデータは rate:null（エラーにしない）', async () => {
  const r = await sniffSampleRate(src(new Array(100).fill(7)));
  assert.equal(r.rate, null);
});
