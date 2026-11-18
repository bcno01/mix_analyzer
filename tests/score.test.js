import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreResult, ramp, standardCurve } from '../src/score/score.js';
import { CRITERIA, PRESETS } from '../src/score/criteria.js';
import { sine, dbToAmp, whiteNoise, analyze, approx } from './helpers.js';

test('ramp: 線形に0〜1へ（どちらの向きでも）、範囲外は丸める', () => {
  assert.equal(ramp(6, 6, 1), 0);
  assert.equal(ramp(1, 6, 1), 1);
  approx(ramp(3.5, 6, 1), 0.5, 1e-12);
  assert.equal(ramp(0, 6, 1), 1);
  assert.equal(ramp(10, 6, 1), 0);
  approx(ramp(0.5, 0, 1), 0.5, 1e-12);
});

test('標準カーブ: 125Hz〜4kHzの帯域の中央値が0で、高域ほど下がる', () => {
  const bands = [];
  for (let k = -16; k <= 13; k++) bands.push({ k, fc: 1000 * Math.pow(2, k / 3) });
  const std = standardCurve(bands, -1.5);
  const ref = bands.filter((b) => b.fc >= 124 && b.fc <= 4050).map((b) => std(b.fc)).sort((a, b) => a - b);
  approx((ref[ref.length / 2 - 1] + ref[ref.length / 2]) / 2, 0, 1e-9);
  approx(std(2000) - std(1000), -1.5, 1e-9);
  assert.ok(std(100) > std(10000));
});

test('スコア: 構造（4項目×25点）と、ラウドネスが目標に合うほど高い・プリセットで目標が動く', () => {
  const fs = 48000;
  const mk = (db) => analyze(fs, sine(fs, 12, 1000, dbToAmp(db), 0, 0.05), null);
  const at = (db, preset) => scoreResult(mk(db), preset);
  const s = at(-17, 'stream');
  assert.equal(s.items.length, 4);
  assert.deepEqual(s.items.map((i) => i.id), ['loudness', 'spectrum', 'stereo', 'dynamics']);
  assert.ok(s.items.every((i) => i.max === CRITERIA.itemMax));
  assert.ok(at(-14, 'stream').items[0].score > at(-24, 'stream').items[0].score);
  assert.ok(at(-23, 'broadcast').items[0].score > at(-23, 'stream').items[0].score);
  assert.ok(at(-9, 'loud').items[0].score > at(-9, 'broadcast').items[0].score);
});

test('スコア: ラウドネス — 目標±1 LU以内でTrue Peakが上限以下なら満点、上限超過で減点', () => {
  const fs = 48000;
  const x = sine(fs, 12, 1000, dbToAmp(-14), 0, 0.05);
  assert.equal(scoreResult(analyze(fs, x, null), 'stream').items[0].score, 25);
  const spiked = Float64Array.from(x);
  spiked[fs * 3] = 1; // True Peak 0 dBTP（上限 -1 を1dB超える）
  assert.ok(scoreResult(analyze(fs, spiked, null), 'stream').items[0].score < 25);
});

test('スコア: ステレオ — モノ相当は満点、逆相は0点', () => {
  const fs = 48000;
  const n = whiteNoise(fs * 6, 0.3, 5);
  assert.equal(scoreResult(analyze(fs, n, Float64Array.from(n)), 'stream').items[2].score, 25);
  assert.equal(scoreResult(analyze(fs, n, Float64Array.from(n, (v) => -v)), 'stream').items[2].score, 0);
});

test('スコア: ダイナミクス — LRAが出ない短尺では残りの項目を25点に換算する', () => {
  const fs = 48000;
  const r = analyze(fs, sine(fs, 2, 1000, dbToAmp(-20), 0, 0.05), null);
  const d = scoreResult(r, 'stream').items[3];
  assert.equal(r.loudness.lra, null);
  assert.equal(d.rows.length, 1);
  assert.ok(d.score !== null && d.score >= 0 && d.score <= 25);
});

test('スコア: 無音は項目も総合も null（エラーにしない）', () => {
  const z = new Float64Array(44100 * 4);
  const s = scoreResult(analyze(44100, z, z), 'stream');
  assert.equal(s.total, null);
  assert.ok(s.items.every((i) => i.score === null));
});

test('スコア: 総合点は4項目の合計（100点満点）の整数', () => {
  const fs = 48000;
  const s = scoreResult(analyze(fs, whiteNoise(fs * 12, 0.3, 31), whiteNoise(fs * 12, 0.3, 32)), 'stream');
  assert.equal(s.total, Math.round(s.items.reduce((x, i) => x + i.score, 0)));
  assert.ok(Number.isInteger(s.total) && s.total >= 0 && s.total <= 100);
  assert.ok(Object.keys(PRESETS).includes(s.preset));
});

test('スコア: 未知のプリセットIDは既定(stream)にフォールバックする', () => {
  const fs = 48000;
  assert.equal(scoreResult(analyze(fs, sine(fs, 8, 1000, dbToAmp(-14)), null), 'nope').preset, 'stream');
});
