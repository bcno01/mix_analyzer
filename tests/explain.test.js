import test from 'node:test';
import assert from 'node:assert/strict';
import ja from '../src/i18n/ja.js';
import en from '../src/i18n/en.js';
import { setLocale } from '../src/i18n/index.js';
import { buildReadings, formatReading } from '../src/explain/readings.js';
import { sine, dbToAmp, whiteNoise, concat, analyze } from './helpers.js';

const allKeys = (res) => Object.values(buildReadings(res)).flat().map((r) => r.key);
const find = (res, section, key) => buildReadings(res)[section].find((r) => r.key === key);

test('読み取り: 出力されるキーと置換パラメータが日本語・英語の両方に定義されている', () => {
  const fs = 48000;
  const cases = [
    analyze(fs, sine(fs, 12, 1000, dbToAmp(-14), 0, 0.05), null),
    analyze(fs, whiteNoise(fs * 10, 0.5, 3), whiteNoise(fs * 10, 0.5, 4)),
    analyze(fs, whiteNoise(fs * 10, 0.4, 5), Float64Array.from(whiteNoise(fs * 10, 0.4, 5), (v) => -v)),
    analyze(fs, concat(sine(fs, 4, 60, 0.3), whiteNoise(fs * 4, 0.05, 6)), null),
  ];
  for (const res of cases) {
    for (const r of Object.values(buildReadings(res)).flat()) {
      assert.ok(r.key in ja && r.key in en, r.key);
      const need = [...ja[r.key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const k of need) assert.ok(r.params && k in r.params, `${r.key} に {${k}} の値が無い`);
      const text = formatReading(r);
      assert.ok(!/\{\w+\}/.test(text), `未置換: ${text}`);
    }
  }
});

test('読み取り: 配信の目安(-14 LUFS)との比較（近い/大きい/小さい）', () => {
  const fs = 48000;
  const mk = (db) => analyze(fs, sine(fs, 12, 1000, dbToAmp(db), 0, 0.05), null);
  assert.equal(find(mk(-14), 'loudness', 'read.loud.near').key, 'read.loud.near');
  assert.ok(find(mk(-9), 'loudness', 'read.loud.louder'));
  assert.ok(find(mk(-20), 'loudness', 'read.loud.quieter'));
  const p = find(mk(-9), 'loudness', 'read.loud.louder').params;
  assert.equal(p.d, '5.0');
});

test('読み取り: True Peak の区分（0超過 / -1超過 / -1以下）', () => {
  const fs = 48000;
  const x = (peak) => { const a = sine(fs, 6, 997, peak, 0, 0.05); return analyze(fs, a, null); };
  assert.ok(find(x(0.5), 'loudness', 'read.tp.ok'));
  assert.ok(find(x(0.95), 'loudness', 'read.tp.hot'));
});

test('読み取り: ステレオ — モノ相当・逆相・独立の相関区分', () => {
  const fs = 48000;
  const n = whiteNoise(fs * 6, 0.3, 1);
  assert.ok(find(analyze(fs, n, Float64Array.from(n)), 'stereo', 'read.st.mono'));
  assert.ok(find(analyze(fs, n, Float64Array.from(n, (v) => -v)), 'stereo', 'read.st.anti'));
  assert.ok(find(analyze(fs, n, whiteNoise(fs * 6, 0.3, 2)), 'stereo', 'read.st.wide'));
});

test('読み取り: 16kHz以上が空のとき（ローパス）に注意が出る', () => {
  const fs = 48000;
  // 1kHzのサイン波だけ → 16kHz以上の帯域は極めて小さい
  const res = analyze(fs, sine(fs, 8, 1000, 0.3, 0, 0.02), null);
  assert.ok(allKeys(res).includes('read.freq.lowpass'));
  const noise = analyze(fs, whiteNoise(fs * 8, 0.3, 12), null);
  assert.ok(!allKeys(noise).includes('read.freq.lowpass'));
});

test('読み取り: 無音・短尺でも例外にならず、算出できない項目は出さない', () => {
  const z = new Float64Array(44100 * 3);
  const r = buildReadings(analyze(44100, z, z));
  assert.deepEqual(r.loudness, []);
  assert.deepEqual(r.freq.filter((x) => x.key !== 'read.freq.lowpass'), []);
  assert.deepEqual(r.stereo, []);
  const short = buildReadings(analyze(48000, sine(48000, 0.5, 1000, 0.3), null));
  assert.ok(Array.isArray(short.loudness));
});

test('読み取り: 日本語・英語どちらでも文章になる（{k:..}の翻訳）', () => {
  const fs = 48000;
  const res = analyze(fs, whiteNoise(fs * 10, 0.4, 5), whiteNoise(fs * 10, 0.4, 6));
  const r = find(res, 'freq', 'read.freq.peak');
  setLocale('ja');
  assert.match(formatReading(r), /Hz/);
  assert.ok(formatReading(r).includes('%'));
  setLocale('en');
  assert.match(formatReading(r), /Hz/);
  setLocale('ja');
});
