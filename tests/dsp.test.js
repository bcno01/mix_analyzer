import test from 'node:test';
import assert from 'node:assert/strict';
import { FFT } from '../src/dsp/fft.js';
import { kWeightCoefficients } from '../src/dsp/kfilter.js';
import { TruePeakMeter } from '../src/dsp/truepeak.js';
import { thirdOctaveBands, integratePsd } from '../src/dsp/bands.js';
import { WelchAccumulator } from '../src/dsp/welch.js';
import { approx, sine, dbToAmp, whiteNoise, concat, analyze } from './helpers.js';

test('K特性フィルタ: 48kHzの第1段係数が仕様値と一致する', () => {
  const { shelf, highpass } = kWeightCoefficients(48000);
  const b = [1.53512485958697, -2.69169618940638, 1.19839281085285];
  const a = [1, -1.69065929318241, 0.73248077421585];
  b.forEach((v, i) => approx(shelf.b[i], v, 1e-12, `b${i}`));
  a.forEach((v, i) => approx(shelf.a[i], v, 1e-12, `a${i}`));
  approx(highpass.a[1], -1.99004745483398, 1e-12);
  approx(highpass.a[2], 0.99007225036621, 1e-12);
  assert.deepEqual(highpass.b, [1, -2, 1]);
});

test('FFT: 素朴なDFTと一致する', () => {
  const n = 64;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) { re[i] = Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.9); im[i] = Math.cos(i * 0.11); }
  const r0 = Float64Array.from(re);
  const i0 = Float64Array.from(im);
  new FFT(n).transform(re, im);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * k * t) / n;
      sr += r0[t] * Math.cos(ang) - i0[t] * Math.sin(ang);
      si += r0[t] * Math.sin(ang) + i0[t] * Math.cos(ang);
    }
    approx(re[k], sr, 1e-9, `re[${k}]`);
    approx(im[k], si, 1e-9, `im[${k}]`);
  }
});

test('FFT: 2のべき乗以外は拒否する', () => {
  assert.throws(() => new FFT(1000));
});

test('ラウドネス: 1kHzサイン波(L=R, -20dBFS)の積算ラウドネスが -20.0 LUFS ±0.1', () => {
  for (const fs of [44100, 48000, 96000]) {
    const x = sine(fs, 20, 1000, dbToAmp(-20));
    const r = analyze(fs, x, Float64Array.from(x));
    approx(r.loudness.integrated, -20.0, 0.1, `fs=${fs}`);
    approx(r.loudness.momentaryMax, -20.0, 0.1);
    approx(r.loudness.shortTermMax, -20.0, 0.1);
    approx(r.loudness.lra, 0, 0.05);
  }
});

test('ラウドネス: モノラル(L=R扱い)とステレオL=Rが一致する', () => {
  const fs = 48000;
  const x = sine(fs, 8, 1000, dbToAmp(-23));
  const m = analyze(fs, x, null);
  const s = analyze(fs, x, Float64Array.from(x));
  approx(m.loudness.integrated, s.loudness.integrated, 1e-9);
  approx(m.loudness.integrated, -23, 0.1);
});

test('ゲート: -70 LUFS未満の無音部と相対ゲート未満の小音量部が積算値から除かれる', () => {
  const fs = 48000;
  const loud = sine(fs, 10, 1000, dbToAmp(-23));
  const quiet = sine(fs, 10, 1000, dbToAmp(-43)); // -43 LUFS: 相対ゲート(約-33.0)未満
  const silence = new Float64Array(fs * 10);
  const x = concat(silence, quiet, loud, silence);
  const r = analyze(fs, x, null);
  approx(r.loudness.integrated, -23, 0.15);
});

test('LRA: 20秒 -20 LUFS + 20秒 -30 LUFS で約10 LU (EBU Tech 3342 case 相当)', () => {
  const fs = 48000;
  const a = sine(fs, 20, 1000, dbToAmp(-20));
  const b = sine(fs, 20, 1000, dbToAmp(-30));
  const r = analyze(fs, concat(a, b), null);
  approx(r.loudness.lra, 10, 0.5);
});

test('True Peak: fs/4・位相45°のサイン波は、サンプルピーク-3dBでもTPは約0 dBTP', () => {
  const fs = 48000;
  const x = sine(fs, 2, fs / 4, 1, Math.PI / 4, 0.1);
  const r = analyze(fs, x, null);
  approx(r.loudness.samplePeak, -3.0103, 0.05, 'sample peak');
  approx(r.loudness.truePeak, 0, 0.05, 'true peak');
});

test('True Peak: 4倍格子で測れる理論下限(cos(πf/4))から0.02dB以内で、決して振幅を超えない', () => {
  // 4倍オーバーサンプリングでは、ピークが格子点の中間に落ちると最大 20log10(cos(πf/4)) dB だけ低く出る
  for (const f of [0.05, 0.1, 0.2, 0.3, 0.4]) {
    const bound = 20 * Math.log10(Math.cos((Math.PI * f) / 4));
    for (const ph of [0.3, 1.1, 1.9, 2.6]) {
      const m = new TruePeakMeter();
      m.process(sine(48000, 0.5, f * 48000, 1, ph, 0.05));
      const tp = 20 * Math.log10(m.finish());
      assert.ok(tp <= 0.02, `f=${f} ph=${ph} tp=${tp} が振幅を超えている`);
      assert.ok(tp >= bound - 0.02, `f=${f} ph=${ph} tp=${tp} < 下限 ${bound}`);
    }
  }
});

test('True Peak: ブロック境界をまたいでも結果が変わらない', () => {
  const x = sine(48000, 1, 11000, 0.9, 0.7, 0.05);
  const whole = new TruePeakMeter();
  whole.process(x);
  const parts = new TruePeakMeter();
  for (let o = 0; o < x.length; o += 777) parts.process(x.subarray(o, Math.min(x.length, o + 777)));
  approx(parts.finish(), whole.finish(), 1e-12);
});

test('サンプルピーク・フルスケール付近のサンプル数', () => {
  const fs = 48000;
  const x = new Float64Array(fs * 2);
  x[100] = 1; x[200] = -0.99995; x[300] = 0.9; // 2個がフルスケール付近
  const r = analyze(fs, x, Float64Array.from(x));
  approx(r.loudness.samplePeak, 0, 1e-9);
  assert.equal(r.loudness.clipSamples, 4); // L,R 各2個
  const mono = analyze(fs, x, null);
  assert.equal(mono.loudness.clipSamples, 2);
});

test('ダイナミクス: RMS・クレストファクター・PLR', () => {
  const fs = 48000;
  const x = sine(fs, 10, 1000, 0.5, 0, 0);
  const r = analyze(fs, x, null);
  approx(r.dynamics.rms, 20 * Math.log10(0.5 / Math.SQRT2), 0.01);
  approx(r.dynamics.crest, 3.0103, 0.02);
  approx(r.dynamics.plr, r.loudness.truePeak - r.loudness.integrated, 1e-9);
  approx(r.dynamics.crestMean, 3.0103, 0.05);
  assert.equal(r.dynamics.crestSeries.length, 10);
});

test('クレストファクター推移: -60 dBFS未満の無音区間は null になり平均から除かれる', () => {
  const fs = 48000;
  const x = concat(sine(fs, 3, 1000, 0.5, 0, 0), new Float64Array(fs * 3));
  const r = analyze(fs, x, null);
  const vals = r.dynamics.crestSeries.map((p) => p.v);
  assert.equal(vals.slice(0, 3).every((v) => v !== null), true);
  assert.equal(vals.slice(3).every((v) => v === null), true);
  approx(r.dynamics.crestMean, 3.0103, 0.05);
});

test('ステレオ: L=R は相関1・サイド比率0、L=-R は相関-1・サイド比率100%', () => {
  const fs = 48000;
  const x = whiteNoise(fs * 4, 0.3, 7);
  const neg = Float64Array.from(x, (v) => -v);
  const same = analyze(fs, x, Float64Array.from(x));
  approx(same.stereo.correlation, 1, 1e-9);
  approx(same.stereo.sideRatio, 0, 1e-9);
  const anti = analyze(fs, x, neg);
  approx(anti.stereo.correlation, -1, 1e-9);
  approx(anti.stereo.sideRatio, 100, 1e-9);
  assert.equal(anti.stereo.sideMinusMid, 120); // Mが0でも±120 dBで丸めて有限にする
  assert.equal(same.stereo.sideMinusMid, -120);
});

test('ステレオ: 独立なノイズ同士は相関が0付近、サイド比率が約50%', () => {
  const fs = 48000;
  const r = analyze(fs, whiteNoise(fs * 6, 0.3, 1), whiteNoise(fs * 6, 0.3, 2));
  approx(r.stereo.correlation, 0, 0.02);
  approx(r.stereo.sideRatio, 50, 1);
  approx(r.stereo.sideMinusMid, 0, 0.2);
});

test('ステレオ: 0.5秒ごとの相関推移と、ゴニオメーターの点数', () => {
  const fs = 48000;
  const x = whiteNoise(fs * 5, 0.3, 3);
  const r = analyze(fs, x, Float64Array.from(x));
  assert.equal(r.stereo.corrSeries.length, 10);
  assert.ok(r.stereo.corrSeries.every((p) => Math.abs(p.v - 1) < 1e-9));
  const pts = r.stereo.goniometer.length / 2;
  assert.ok(pts > 0 && pts <= 40000 + 2, `points=${pts}`);
  // L=R なら横軸(L-R)/√2は0
  for (let i = 0; i < pts; i++) assert.equal(r.stereo.goniometer[i * 2], 0);
});

test('Welch: ホワイトノイズのPSDが理論値(2σ²/fs)に近く、帯域エネルギーが一致する', () => {
  const fs = 48000;
  const amp = 0.5; // 一様乱数 [-a,a] の分散 = a²/3
  const x = whiteNoise(fs * 12, amp, 5);
  const w = new WelchAccumulator(fs, x.length);
  w.push(x, x);
  const psd = w.finish();
  const sigma2 = (amp * amp) / 3;
  const expected = (2 * sigma2) / fs; // 片側PSD
  const mid = psd.pll.slice(2000, 12000);
  const mean = mid.reduce((a, b) => a + b, 0) / mid.length;
  approx(mean / expected, 1, 0.03);
  // 全帯域の積分 ≈ 分散
  const total = integratePsd(psd.pll, psd.df, 0, fs / 2);
  approx(total / sigma2, 1, 0.03);
});

test('1/3オクターブ帯域: 中心周波数・帯域端・ナイキスト上限', () => {
  const b = thirdOctaveBands(48000);
  approx(b[0].fc, 1000 * Math.pow(2, -16 / 3), 1e-9);
  approx(b[0].lo, b[0].fc / Math.pow(2, 1 / 6), 1e-9);
  approx(b[0].hi, b[0].fc * Math.pow(2, 1 / 6), 1e-9);
  assert.ok(b.at(-1).hi <= 24000);
  assert.ok(b.every((x, i) => i === 0 || x.k === b[i - 1].k + 1));
  const low = thirdOctaveBands(22050);
  assert.ok(low.at(-1).hi <= 11025);
});

test('周波数バランス: 1kHzのサイン波は1kHz帯域が最大で、7帯域では500-2kに集中する', () => {
  const fs = 48000;
  const x = sine(fs, 8, 1000, 0.5, 0, 0.01);
  const r = analyze(fs, x, null);
  const bands = r.spectrum.bands;
  const peak = bands.reduce((a, b) => (b.db > a.db ? b : a));
  assert.equal(Math.round(peak.fc), 1000);
  const seven = r.spectrum.seven;
  assert.ok(seven[3].percent > 99, `500-2k = ${seven[3].percent}`);
  approx(seven.reduce((a, s) => a + s.percent, 0), 100, 1e-9);
});

test('周波数バランス: ホワイトノイズは高域ほど1/3oct帯域エネルギーが増える（+3dB/oct）', () => {
  const fs = 48000;
  const r = analyze(fs, whiteNoise(fs * 12, 0.4, 11), null);
  const b = r.spectrum.bands;
  const at = (fc) => b.find((x) => Math.abs(x.fc - fc) < 1).db;
  approx(at(4000) - at(1000), 6.02, 0.5); // 2オクターブ = +6 dB
  approx(at(1000) - at(250), 6.02, 0.5);
});

test('周波数バランス: 125〜4kHzの中央値が0 dB基準になる', () => {
  const fs = 48000;
  const r = analyze(fs, whiteNoise(fs * 10, 0.4, 13), null);
  const ref = r.spectrum.bands.filter((b) => b.fc >= 124 && b.fc <= 4050).map((b) => b.db).sort((a, b) => a - b);
  const n = ref.length;
  const med = n % 2 ? ref[(n - 1) / 2] : (ref[n / 2 - 1] + ref[n / 2]) / 2;
  approx(med, 0, 1e-9);
});

test('ステレオ帯域: 低域だけ逆相にすると 20–120Hz の S−M が上がり、その帯域のL/R相関が負になる', () => {
  const fs = 48000;
  const low = sine(fs, 8, 60, 0.3, 0, 0.01);
  const high = sine(fs, 8, 2000, 0.3, 0, 0.01);
  const L = new Float64Array(low.length);
  const R = new Float64Array(low.length);
  for (let i = 0; i < L.length; i++) { L[i] = low[i] + high[i]; R[i] = -low[i] + high[i]; }
  const r = analyze(fs, L, R);
  assert.ok(r.stereo.lowSideMinusMid > 20, `lowSM=${r.stereo.lowSideMinusMid}`);
  const b60 = r.spectrum.bands.find((b) => Math.abs(b.fc - 63.0) < 1);
  const b2k = r.spectrum.bands.find((b) => Math.abs(b.fc - 2000) < 1);
  assert.ok(b60.correlation < -0.99);
  assert.ok(b2k.correlation > 0.99);
});

test('端的なケース: 全体が無音でもエラーにならず、算出できない項目は null', () => {
  const fs = 44100;
  const z = new Float64Array(fs * 5);
  const r = analyze(fs, z, z);
  const l = r.loudness;
  assert.equal(l.integrated, null);
  assert.equal(l.lra, null);
  assert.equal(l.truePeak, null);
  assert.equal(l.samplePeak, null);
  assert.equal(r.dynamics.rms, null);
  assert.equal(r.dynamics.crest, null);
  assert.equal(r.dynamics.plr, null);
  assert.equal(r.stereo.correlation, null);
  assert.equal(r.stereo.sideRatio, null);
  assert.ok(r.spectrum.bands.every((b) => b.db === null));
  assert.ok(r.spectrum.seven.every((s) => s.percent === null));
});

test('端的なケース: 3秒未満はショートターム・LRAが null、積算は出る', () => {
  const fs = 48000;
  const x = sine(fs, 2, 1000, dbToAmp(-20));
  const r = analyze(fs, x, null);
  assert.equal(r.loudness.lra, null);
  assert.equal(r.loudness.shortTermMax, null);
  approx(r.loudness.integrated, -20, 0.2);
});

test('端的なケース: 400ms未満・極端に短い入力でも例外にならない', () => {
  const fs = 48000;
  for (const n of [1, 10, 500, 5000, 19199]) {
    const x = sine(fs, n / fs, 1000, 0.5, 0, 0);
    const r = analyze(fs, x, null);
    assert.equal(r.loudness.integrated, null);
    assert.equal(r.meta.frames, n);
  }
});

test('端的なケース: 長さ0は EMPTY で明示的に失敗する', () => {
  assert.throws(() => analyze(48000, new Float64Array(0), null), /EMPTY/);
});

test('ブロック分割に依存しない: チャンク長を変えても結果が一致する', () => {
  const fs = 48000;
  const L = whiteNoise(fs * 7, 0.3, 21);
  const R = whiteNoise(fs * 7, 0.2, 22);
  const a = analyze(fs, L, R, 4096);
  const b = analyze(fs, L, R, 100003);
  approx(a.loudness.integrated, b.loudness.integrated, 1e-9);
  approx(a.loudness.truePeak, b.loudness.truePeak, 1e-9);
  approx(a.stereo.correlation, b.stereo.correlation, 1e-9);
  approx(a.spectrum.bands[10].db, b.spectrum.bands[10].db, 1e-9);
  assert.equal(a.stereo.corrSeries.length, b.stereo.corrSeries.length);
});

test('44.1k/48k/96k × モノ/ステレオ が動く', () => {
  for (const fs of [44100, 48000, 96000]) {
    const L = sine(fs, 4, 440, 0.3);
    const R = sine(fs, 4, 660, 0.3);
    const st = analyze(fs, L, R);
    const mo = analyze(fs, L, null);
    assert.ok(Number.isFinite(st.loudness.integrated));
    assert.ok(Number.isFinite(mo.loudness.integrated));
    assert.equal(st.meta.sampleRate, fs);
  }
});
