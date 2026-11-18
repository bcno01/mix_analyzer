"""JS実装（src/）の解析結果を、独立した参照実装と照合する検証スクリプト。

照合先:
  1. ffmpeg の ebur128=peak=true（積算ラウドネス・LRA・True Peak）
  2. numpy/scipy で書いた参照実装（積算ラウドネス・LRA・True Peak[resample_poly]・
     Welch[scipy.signal.welch]から作る1/3オクターブ帯域・ステレオ指標）

使い方（Python 3.13 のフルパスで。numpy/scipy/imageio-ffmpeg が必要）:
    python -X utf8 tools/verify_reference.py <音声ファイル> [<音声ファイル> ...]
    python -X utf8 tools/verify_reference.py --synthetic     # 合成信号だけ

入力は ffmpeg で 32bit float WAV（元のサンプルレートのまま）にしてから、JS側とffmpeg側に同じものを渡す。
モノラルは仕様どおり L=R として扱うので、ffmpeg側にも dual mono（pan=stereo|c0=c0|c1=c0）で渡す。
許容差: 積算ラウドネス・LRA・True Peak は ffmpeg と ±0.1 以内。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.io import wavfile

import imageio_ffmpeg

ROOT = Path(__file__).resolve().parent.parent
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
NODE = "node"
TOL = 0.1


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)


# ---------------------------------------------------------------- 参照実装
def kweight(x: np.ndarray, fs: int) -> np.ndarray:
    f0, G, Q = 1681.9744509555319, 3.999843853973347, 0.7071752369554196
    K = np.tan(np.pi * f0 / fs)
    Vh = 10 ** (G / 20)
    Vb = Vh ** 0.4996667741545416
    a0 = 1 + K / Q + K * K
    b = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0]
    a = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
    y = signal.lfilter(b, a, x)
    f1, Q1 = 38.13547087602444, 0.5003270373238773
    K = np.tan(np.pi * f1 / fs)
    a0 = 1 + K / Q1 + K * K
    return signal.lfilter([1, -2, 1], [1, 2 * (K * K - 1) / a0, (1 - K / Q1 + K * K) / a0], y)


def lufs(e):
    return -0.691 + 10 * np.log10(e) if e > 0 else -np.inf


def ref_loudness(L, R, fs):
    sub = int(round(fs * 0.1))
    n = len(L) // sub
    e = np.zeros(n)
    for ch in (L, R):
        y = kweight(ch.astype(np.float64), fs)[: n * sub]
        e += (y.reshape(n, sub) ** 2).mean(axis=1)
    cum = np.concatenate([[0], np.cumsum(e)])

    def win(k):
        return (cum[k:] - cum[:-k]) / k if n >= k else np.array([])

    mom, st = win(4), win(30)
    absE = 10 ** ((-70 + 0.691) / 10)

    def gated(v, off):
        v = v[v > absE]
        if len(v) == 0:
            return None
        thr = 10 ** ((lufs(v.mean()) + off + 0.691) / 10)
        v = v[v > thr]
        return lufs(v.mean()) if len(v) else None

    integrated = gated(mom, -10)
    lra = None
    v = st[st > absE]
    if len(v):
        thr = 10 ** ((lufs(v.mean()) - 20 + 0.691) / 10)
        v = v[v > thr]
        if len(v):
            ls = np.array([lufs(x) for x in v])
            lra = float(np.percentile(ls, 95) - np.percentile(ls, 10))
    return integrated, lra


def ref_true_peak(L, R):
    tp = 0.0
    for ch in (L, R):
        up = signal.resample_poly(ch.astype(np.float64), 4, 1)
        tp = max(tp, float(np.abs(up).max()))
    return 20 * np.log10(tp) if tp > 0 else None


def third_octave(fs):
    out = []
    k = -16
    while True:
        fc = 1000 * 2 ** (k / 3)
        lo, hi = fc / 2 ** (1 / 6), fc * 2 ** (1 / 6)
        if hi > fs / 2:
            return out
        out.append((k, fc, lo, hi))
        k += 1


def integrate(psd, df, lo, hi):
    s = 0.0
    for k in range(max(0, int(lo / df - 1)), min(len(psd), int(hi / df + 2))):
        a, b = max(lo, (k - 0.5) * df), min(hi, (k + 0.5) * df)
        if b > a:
            s += psd[k] * (b - a)
    return s


def ref_bands(L, R, fs):
    kw = dict(fs=fs, window="hann", nperseg=32768, noverlap=16384, detrend="constant", scaling="density")
    f, pl = signal.welch(L, **kw)
    _, pr = signal.welch(R, **kw)
    _, plr = signal.csd(L, R, **kw)
    df = f[1] - f[0]
    avg = (pl + pr) / 2
    rows = []
    for k, fc, lo, hi in third_octave(fs):
        e = integrate(avg, df, lo, hi)
        ll, rr, lr = integrate(pl, df, lo, hi), integrate(pr, df, lo, hi), integrate(plr.real, df, lo, hi)
        rows.append((k, fc, e, lr / np.sqrt(ll * rr) if ll * rr > 0 else None))
    ref = np.median([10 * np.log10(e) for k, fc, e, c in rows if 124 <= fc <= 4050 and e > 0])
    return [(k, fc, 10 * np.log10(e) - ref if e > 0 else None, c) for k, fc, e, c in rows]


def ref_stereo(L, R):
    corr = float(np.corrcoef(L, R)[0, 1])
    M, S = (L + R) / 2, (L - R) / 2
    sm, ss = float((M ** 2).sum()), float((S ** 2).sum())
    return corr, ss / (sm + ss) * 100, 10 * np.log10(ss / sm)


# ---------------------------------------------------------------- ffmpeg
def ffmpeg_ebur128(path: Path, dual_mono: bool):
    af = "ebur128=peak=true"
    if dual_mono:
        af = "pan=stereo|c0=c0|c1=c0," + af
    r = run([FFMPEG, "-nostats", "-hide_banner", "-i", str(path), "-af", af, "-f", "null", "-"])
    txt = r.stderr
    tail = txt[txt.rfind("Summary:"):]

    def grab(label):
        m = re.search(label + r":\s+(-?\d+(?:\.\d+)?)", tail)
        return float(m.group(1)) if m else None

    return {"I": grab(r"\n\s+I"), "LRA": grab(r"\n\s+LRA"), "TP": grab(r"True peak:\s*\n\s+Peak")}


def to_float_wav(src: Path, dst: Path):
    r = run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", str(src), "-vn", "-c:a", "pcm_f32le", str(dst)])
    if r.returncode != 0:
        raise RuntimeError(r.stderr)


def js_analyze(path: Path):
    r = run([NODE, str(ROOT / "tools" / "analyze_cli.mjs"), str(path)], cwd=ROOT)
    if r.returncode != 0:
        raise RuntimeError(r.stderr)
    return json.loads(r.stdout)


# ---------------------------------------------------------------- 合成信号
def synth(tmp: Path):
    fs = 48000
    t = np.arange(fs * 30) / fs
    rng = np.random.default_rng(1)
    out = {}
    s = 0.1 * np.sin(2 * np.pi * 1000 * t)
    out["sine1k_-20dBFS_48k"] = np.stack([s, s], 1)
    # 音楽的な変化を持つ信号: ピンクっぽいノイズ + 低域 + 拍ごとのエンベロープ + 左右で異なる成分
    white = rng.standard_normal((len(t), 2))
    pink = signal.lfilter([0.049922035, -0.095993537, 0.050612699, -0.004408786], [1, -2.494956002, 2.017265875, -0.522189400], white, axis=0)
    env = 0.35 + 0.65 * (np.sin(2 * np.pi * 2 * t) > 0)
    bass = 0.25 * np.sin(2 * np.pi * 55 * t) * env
    sec = np.where((t % 10) < 6, 1.0, 0.18)
    x = (0.12 * pink + bass[:, None]) * sec[:, None]
    x[:, 1] += 0.05 * np.sin(2 * np.pi * 3000 * t)
    out["music_like_48k"] = np.clip(x, -1, 1)
    # 96k / モノラル
    fs2 = 96000
    t2 = np.arange(fs2 * 12) / fs2
    m = 0.2 * rng.standard_normal(len(t2)) * (0.6 + 0.4 * np.sin(2 * np.pi * t2))
    out["mono_noise_96k"] = (m[:, None], fs2)
    for name, v in out.items():
        data, rate = (v if isinstance(v, tuple) else (v, fs))
        p = tmp / f"{name}.wav"
        wavfile.write(p, rate, data.astype(np.float32))
        yield p


# ---------------------------------------------------------------- メイン
def check(name, js, ref, tol, ok_list, info_only=False):
    if js is None and ref is None:
        print(f"    {name:<28} JS=—  参照=—   (一致)")
        return
    if js is None or ref is None:
        print(f"    {name:<28} JS={js}  参照={ref}   ★片方だけ null")
        ok_list.append(False)
        return
    d = js - ref
    good = abs(d) <= tol
    if not info_only:
        ok_list.append(good)
    mark = "OK" if good else ("(参考: 短尺のためffmpegのLRAは窓数が少なく不安定)" if info_only else "★NG")
    print(f"    {name:<28} JS={js:9.3f}  参照={ref:9.3f}  差={d:+.3f}  {mark}")


def verify(path: Path, tmp: Path) -> bool:
    wav = tmp / "ref_input.wav"
    to_float_wav(path, wav)
    fs, data = wavfile.read(wav)
    data = data.astype(np.float64)
    if data.ndim == 1:
        data = data[:, None]
    mono = data.shape[1] == 1
    L = data[:, 0]
    R = L if mono else data[:, 1]
    print(f"\n== {path.name}  ({fs} Hz, {'mono→L=R' if mono else str(data.shape[1]) + 'ch'}, {len(L) / fs:.1f} s)")

    js = js_analyze(wav)
    ff = ffmpeg_ebur128(wav, mono)
    ri, rl = ref_loudness(L, R, fs)
    rtp = ref_true_peak(L, R)
    ok = []
    ld = js["loudness"]
    print("  [ffmpeg ebur128=peak=true] ±%.1f" % TOL)
    check("積算ラウドネス LUFS", ld["integrated"], ff["I"], TOL, ok)
    # 3秒窓が10個程度しか取れない短尺(<20秒)では、ffmpegのLRAは参考値（参照実装とは完全一致する）
    check("LRA LU", ld["lra"], ff["LRA"], TOL, ok, info_only=len(L) / fs < 20)
    check("True Peak dBTP", ld["truePeak"], ff["TP"], TOL, ok)
    print("  [numpy/scipy 参照実装]")
    check("積算ラウドネス LUFS", ld["integrated"], ri, 0.01, ok)
    check("LRA LU", ld["lra"], rl, 0.01, ok)
    check("True Peak dBTP(resample_poly)", ld["truePeak"], rtp, 0.15, ok)

    bands = js["spectrum"]["bands"] if js["spectrum"] else []
    if bands:
        rb = ref_bands(L, R, fs)
        worst_db = max((abs(b["db"] - r[2]) for b, r in zip(bands, rb) if b["db"] is not None and r[2] is not None), default=0)
        worst_c = max((abs(b["correlation"] - r[3]) for b, r in zip(bands, rb) if b["correlation"] is not None and r[3] is not None), default=0)
        good = worst_db < 0.01 and worst_c < 0.001
        ok.append(good)
        print(f"    1/3oct帯域 dB(scipy.welch)   最大差={worst_db:.5f} dB   帯域別相関 最大差={worst_c:.6f}   {'OK' if good else '★NG'}")
    st = js["stereo"]
    if st["correlation"] is not None:
        c, side, sm = ref_stereo(L, R)
        good = abs(st["correlation"] - c) < 1e-6 and abs(st["sideRatio"] - side) < 1e-4 and (abs(st["sideMinusMid"] - sm) < 1e-3 or sm < -100)
        ok.append(good)
        print(f"    ステレオ 相関 JS={st['correlation']:.5f}/参照={c:.5f}  サイド比率 JS={st['sideRatio']:.4f}/参照={side:.4f}  {'OK' if good else '★NG'}")
    print(f"    JS解析時間 {js['elapsedMs']} ms")
    return all(ok)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        files = [Path(a) for a in args]
        if "--synthetic" in sys.argv or not files:
            files += list(synth(tmp))
        results = [verify(f, tmp) for f in files]
    print("\n結果:", "すべてOK" if all(results) else "不一致あり", f"({sum(results)}/{len(results)})")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
