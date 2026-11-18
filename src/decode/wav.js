// WAV(RIFF/RF64) の自前パーサ。元のサンプルレート・ビット深度をそのまま扱う。
// ByteSource: { size:number, read(start,end):Promise<ArrayBuffer> }（Fileや、テスト用のBufferで実装）

export class UnsupportedFormatError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'UnsupportedFormatError';
    this.reason = reason;
  }
}

export function fileSource(file) {
  return { size: file.size, read: (s, e) => file.slice(s, e).arrayBuffer() };
}

const ascii = (dv, off, len) => {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
  return s;
};

/** WAVらしいか（先頭12バイト）。 */
export function looksLikeWav(bytes) {
  if (bytes.length < 12) return false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = ascii(dv, 0, 4);
  return (id === 'RIFF' || id === 'RF64' || id === 'BW64') && ascii(dv, 8, 4) === 'WAVE';
}

/**
 * ヘッダを解析する。
 * @returns {{sampleRate, channels, bits, kind:'int'|'float'|'uint8', blockAlign, dataOffset, dataBytes, frames}}
 */
export async function parseWav(src) {
  if (src.size < 44) throw new UnsupportedFormatError('too-small');
  const head = new DataView(await src.read(0, 12));
  const riff = ascii(head, 0, 4);
  if (!(riff === 'RIFF' || riff === 'RF64' || riff === 'BW64') || ascii(head, 8, 4) !== 'WAVE') {
    throw new UnsupportedFormatError('not-wav');
  }
  let pos = 12;
  let fmt = null;
  let ds64Data = null;
  let dataOffset = -1;
  let dataBytes = 0;

  while (pos + 8 <= src.size) {
    const h = new DataView(await src.read(pos, pos + 8));
    const id = ascii(h, 0, 4);
    const size = h.getUint32(4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      const len = Math.min(size, 40);
      const d = new DataView(await src.read(body, body + len));
      if (len < 16) throw new UnsupportedFormatError('bad-fmt');
      let tag = d.getUint16(0, true);
      const f = {
        channels: d.getUint16(2, true),
        sampleRate: d.getUint32(4, true),
        blockAlign: d.getUint16(12, true),
        bits: d.getUint16(14, true),
      };
      if (tag === 0xfffe && len >= 26) tag = d.getUint16(24, true); // SubFormat GUIDの先頭2バイト
      f.tag = tag;
      fmt = f;
    } else if (id === 'ds64') {
      const d = new DataView(await src.read(body, body + 24));
      ds64Data = Number(d.getBigUint64(8, true));
    } else if (id === 'data') {
      dataOffset = body;
      dataBytes = size;
      if (size === 0xffffffff && ds64Data !== null) dataBytes = ds64Data;
      break;
    }
    if (size === 0xffffffff) break;
    pos = body + size + (size & 1);
  }

  if (!fmt) throw new UnsupportedFormatError('no-fmt');
  if (dataOffset < 0) throw new UnsupportedFormatError('no-data');
  if (fmt.channels < 1 || !(fmt.sampleRate > 0)) throw new UnsupportedFormatError('bad-fmt');

  let kind;
  if (fmt.tag === 1 && fmt.bits === 8) kind = 'uint8';
  else if (fmt.tag === 1 && (fmt.bits === 16 || fmt.bits === 24 || fmt.bits === 32)) kind = 'int';
  else if (fmt.tag === 3 && (fmt.bits === 32 || fmt.bits === 64)) kind = 'float';
  else throw new UnsupportedFormatError('codec-' + fmt.tag + '-' + fmt.bits);

  const bytesPer = fmt.bits / 8;
  const blockAlign = fmt.blockAlign >= bytesPer * fmt.channels ? fmt.blockAlign : bytesPer * fmt.channels;
  // データ長が不正（0・ファイルより大きい＝ストリーム書き出しなど）なら残り全部を使う
  const avail = src.size - dataOffset;
  if (dataBytes === 0 || dataBytes > avail) dataBytes = avail;
  const frames = Math.floor(dataBytes / blockAlign);

  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bits: fmt.bits,
    kind,
    blockAlign,
    dataOffset,
    dataBytes: frames * blockAlign,
    frames,
  };
}

/**
 * インターリーブされたバイト列を、先頭2chの Float64Array へ変換する（-1〜1に正規化）。
 * モノラルのときは R に L と同じ値を入れる（呼び出し側が isMono として扱うなら R===L でもよい）。
 */
export function decodeFrames(buffer, info, nFrames, L, R) {
  const { channels, bits, kind, blockAlign } = info;
  const bytesPer = bits / 8;
  const stride = blockAlign / bytesPer; // 1フレームあたりの要素数
  const second = channels >= 2 ? 1 : 0;

  if (kind === 'uint8') {
    const a = new Uint8Array(buffer);
    for (let i = 0; i < nFrames; i++) {
      L[i] = (a[i * stride] - 128) / 128;
      R[i] = (a[i * stride + second] - 128) / 128;
    }
  } else if (kind === 'int' && bits === 16 && Number.isInteger(stride)) {
    const a = new Int16Array(buffer, 0, nFrames * stride);
    for (let i = 0; i < nFrames; i++) {
      L[i] = a[i * stride] / 32768;
      R[i] = a[i * stride + second] / 32768;
    }
  } else if (kind === 'int' && bits === 24) {
    const a = new Uint8Array(buffer);
    const rd = (o) => {
      const v = (a[o] | (a[o + 1] << 8) | (a[o + 2] << 16)) << 8 >> 8; // 符号拡張
      return v / 8388608;
    };
    const off2 = second * 3;
    for (let i = 0; i < nFrames; i++) {
      const o = i * blockAlign;
      L[i] = rd(o);
      R[i] = rd(o + off2);
    }
  } else if (kind === 'int' && bits === 32 && Number.isInteger(stride)) {
    const a = new Int32Array(buffer, 0, nFrames * stride);
    for (let i = 0; i < nFrames; i++) {
      L[i] = a[i * stride] / 2147483648;
      R[i] = a[i * stride + second] / 2147483648;
    }
  } else if (kind === 'float' && bits === 32 && Number.isInteger(stride)) {
    const a = new Float32Array(buffer, 0, nFrames * stride);
    for (let i = 0; i < nFrames; i++) {
      L[i] = a[i * stride];
      R[i] = a[i * stride + second];
    }
  } else if (kind === 'float' && bits === 64 && Number.isInteger(stride)) {
    const a = new Float64Array(buffer, 0, nFrames * stride);
    for (let i = 0; i < nFrames; i++) {
      L[i] = a[i * stride];
      R[i] = a[i * stride + second];
    }
  } else {
    throw new UnsupportedFormatError('layout');
  }
}

/** 形式の表示用文字列（例: "WAV 24bit PCM"）。 */
export function describeWav(info) {
  const type = info.kind === 'float' ? 'float' : 'PCM';
  return `WAV ${info.bits}bit ${type}`;
}
