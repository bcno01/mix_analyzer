// WAV以外（MP3 / FLAC / AAC など）はブラウザのデコーダに任せる。メインスレッド専用。
// decodeAudioData はAudioContextのレートへリサンプルするので、ヘッダから読んだ元のレートの
// OfflineAudioContext で復号し、復号後のレートを検証する。

import { fileSource } from './wav.js';
import { sniffSampleRate } from './sniff.js';

const FALLBACK_RATE = 48000;

export class DecodeError extends Error {}

function makeContext(rate) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctx) throw new DecodeError('no-webaudio');
  return new Ctx(2, 1, rate);
}

/**
 * @returns {Promise<{buffer:AudioBuffer, sampleRate:number, format:string, sourceRate:number|null, resampled:boolean, rateUnknown:boolean, channels:number}>}
 */
export async function decodeWithWebAudio(file) {
  const src = fileSource(file);
  let sniffed = { kind: 'unknown', rate: null };
  try {
    sniffed = await sniffSampleRate(src);
  } catch {
    /* 判別できなくても復号は試す */
  }

  let ctx;
  let requested = sniffed.rate;
  if (requested) {
    try {
      ctx = makeContext(requested);
    } catch {
      ctx = null; // このブラウザが受け付けないレート
    }
  }
  if (!ctx) ctx = makeContext(FALLBACK_RATE);

  const data = await file.arrayBuffer();
  let buffer;
  try {
    buffer = await ctx.decodeAudioData(data);
  } catch (e) {
    throw new DecodeError('decode-failed');
  }

  const rateUnknown = !sniffed.rate;
  const resampled = !!sniffed.rate && buffer.sampleRate !== sniffed.rate;
  return {
    buffer,
    sampleRate: buffer.sampleRate,
    format: sniffed.kind,
    sourceRate: sniffed.rate,
    resampled,
    rateUnknown,
    channels: buffer.numberOfChannels,
  };
}
