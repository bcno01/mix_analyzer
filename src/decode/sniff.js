// 圧縮形式の「元のサンプルレート」をヘッダから読む（decodeAudioDataは既定でAudioContextのレートへ
// リサンプルしてしまうため、元のレートで復号するために先に知っておく）。
// ByteSource は wav.js と同じ { size, read(start,end) }。判別できなければ rate: null。

const MP3_RATES = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};
const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

const tag4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function mp3OrAdts(b, start) {
  const end = Math.min(b.length - 4, start + 8192);
  for (let i = start; i < end; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    if ((b[i + 1] & 0xf6) === 0xf0) {
      // ADTS (AAC): layer==0
      const idx = (b[i + 2] >> 2) & 0xf;
      if (idx < ADTS_RATES.length) return { kind: 'aac', rate: ADTS_RATES[idx] };
      continue;
    }
    const ver = (b[i + 1] >> 3) & 3;
    const layer = (b[i + 1] >> 1) & 3;
    const idx = (b[i + 2] >> 2) & 3;
    if (ver === 1 || layer === 0 || idx === 3) continue;
    return { kind: 'mp3', rate: MP3_RATES[ver][idx] };
  }
  return null;
}

function parseMdhdRate(box) {
  // box: mdhd のペイロード（version/flags から）
  const v = box[0];
  const o = v === 1 ? 20 : 12;
  return ((box[o] << 24) | (box[o + 1] << 16) | (box[o + 2] << 8) | box[o + 3]) >>> 0;
}

/** moov のバイト列から音声トラックのレート（mdhd.timescale）を探す。 */
function mp4AudioRate(moov) {
  const u32 = (o) => ((moov[o] << 24) | (moov[o + 1] << 16) | (moov[o + 2] << 8) | moov[o + 3]) >>> 0;
  const walk = (start, end, path, state) => {
    let p = start;
    while (p + 8 <= end) {
      let size = u32(p);
      const type = tag4(moov, p + 4);
      let hdr = 8;
      if (size === 1) { size = u32(p + 12); hdr = 16; } // 64bitサイズ（上位32bitは無視）
      if (size === 0) size = end - p;
      if (size < hdr || p + size > end) break;
      const body = p + hdr;
      if (type === 'trak') { state.mdhd = null; state.soun = false; walk(body, p + size, 'trak', state); if (state.soun && state.mdhd) return state.mdhd; }
      else if (type === 'mdia') { const r = walk(body, p + size, 'mdia', state); if (r) return r; }
      else if (type === 'mdhd') state.mdhd = parseMdhdRate(moov.subarray(body, p + size));
      else if (type === 'hdlr') state.soun = tag4(moov, body + 8) === 'soun';
      else if (type === 'moov') { const r = walk(body, p + size, 'moov', state); if (r) return r; }
      p += size;
    }
    return null;
  };
  return walk(0, moov.length, '', { mdhd: null, soun: false });
}

async function sniffMp4(src) {
  // トップレベルのboxをたどって moov を探す（faststartでなくても対応）
  let pos = 0;
  while (pos + 8 <= src.size) {
    const h = new Uint8Array(await src.read(pos, Math.min(src.size, pos + 16)));
    let size = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
    const type = tag4(h, 4);
    let hdr = 8;
    if (size === 1 && h.length >= 16) {
      size = ((h[12] << 24) | (h[13] << 16) | (h[14] << 8) | h[15]) >>> 0; // 上位32bitは無視
      hdr = 16;
    } else if (size === 0) size = src.size - pos;
    if (size < hdr) break;
    if (type === 'moov') {
      if (size > 64 * 1024 * 1024) return null;
      const moov = new Uint8Array(await src.read(pos, pos + size));
      const rate = mp4AudioRate(moov);
      return rate ? { kind: 'mp4', rate } : null;
    }
    pos += size;
  }
  return null;
}

/** @returns {Promise<{kind:string, rate:number|null}>} */
export async function sniffSampleRate(src) {
  const head = new Uint8Array(await src.read(0, Math.min(src.size, 16384)));
  if (head.length < 12) return { kind: 'unknown', rate: null };

  let off = 0;
  if (tag4(head, 0).startsWith('ID3')) {
    // ID3v2 タグを飛ばす（syncsafe整数）
    const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
    off = 10 + size;
    if (off + 16384 > src.size) off = Math.min(off, src.size);
    const rest = new Uint8Array(await src.read(off, Math.min(src.size, off + 16384)));
    if (rest.length >= 4) {
      if (tag4(rest, 0) === 'fLaC') return flac(rest, 0);
      const r = mp3OrAdts(rest, 0);
      if (r) return r;
    }
    return { kind: 'unknown', rate: null };
  }

  if (tag4(head, 0) === 'fLaC') return flac(head, 0);
  if (tag4(head, 4) === 'ftyp') {
    const r = await sniffMp4(src);
    return r || { kind: 'mp4', rate: null };
  }
  if (tag4(head, 0) === 'OggS') {
    const text = Array.from(head.subarray(0, 512), (c) => String.fromCharCode(c)).join('');
    const v = text.indexOf('\x01vorbis');
    if (v >= 0) {
      const o = v + 12;
      return { kind: 'vorbis', rate: (head[o] | (head[o + 1] << 8) | (head[o + 2] << 16) | (head[o + 3] << 24)) >>> 0 };
    }
    if (text.includes('OpusHead')) return { kind: 'opus', rate: 48000 }; // Opusは常に48kHzで復号される
    return { kind: 'ogg', rate: null };
  }
  const r = mp3OrAdts(head, 0);
  return r || { kind: 'unknown', rate: null };
}

function flac(b, base) {
  // 'fLaC' + ブロックヘッダ4バイト + STREAMINFO。サンプルレートは先頭から10バイト後に20bit。
  const o = base + 8 + 10;
  if (b.length < o + 3) return { kind: 'flac', rate: null };
  const rate = (b[o] << 12) | (b[o + 1] << 4) | (b[o + 2] >> 4);
  return { kind: 'flac', rate: rate > 0 ? rate : null };
}
