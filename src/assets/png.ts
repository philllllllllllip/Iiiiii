// Exact PNG decoder (RGBA8 output). Browsers' canvas/ImageBitmap paths may premultiply alpha or apply
// colour management, which is lossy for low-alpha texels; vanilla textures must arrive byte-exact.
import { unzlibSync } from 'fflate';

export interface RGBAImage { width: number; height: number; data: Uint8Array }

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

export function decodePng(buf: Uint8Array): RGBAImage {
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('not a PNG');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 8;
  let width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  let palette: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (off < buf.length) {
    const len = dv.getUint32(off); const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(off + 8); height = dv.getUint32(off + 12);
      depth = body[8]; ctype = body[9]; interlace = body[12];
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (interlace) throw new Error('interlaced PNG not supported');
  let total = 0; for (const c of idat) total += c.length;
  const z = new Uint8Array(total); let p = 0; for (const c of idat) { z.set(c, p); p += c.length; }
  const raw = unzlibSync(z);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype as 0 | 2 | 3 | 4 | 6];
  if (!channels) throw new Error('bad PNG colour type ' + ctype);
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = (width * channels * depth + 7) >> 3;
  const lines = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0, r = 0; y < height; y++) {
    const ft = raw[r++];
    const line = lines.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const v = raw[r++];
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let o: number;
      switch (ft) {
        case 0: o = v; break;
        case 1: o = v + a; break;
        case 2: o = v + b; break;
        case 3: o = v + ((a + b) >> 1); break;
        case 4: { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); o = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: throw new Error('bad PNG filter ' + ft);
      }
      line[x] = o & 255;
    }
    prev = line;
  }
  const out = new Uint8Array(width * height * 4);
  const sample = (line: Uint8Array, i: number): number => {
    if (depth === 8) return line[i];
    if (depth === 16) return line[i * 2];
    const perByte = 8 / depth; const byte = line[Math.floor(i / perByte)];
    const shift = 8 - depth * (1 + (i % perByte));
    return (byte >> shift) & ((1 << depth) - 1);
  };
  const scale = depth < 8 && ctype !== 3 ? 255 / ((1 << depth) - 1) : 1;
  for (let y = 0; y < height; y++) {
    const line = lines.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (ctype === 6) { for (let k = 0; k < 4; k++) out[o + k] = sample(line, x * 4 + k); }
      else if (ctype === 2) { for (let k = 0; k < 3; k++) out[o + k] = sample(line, x * 3 + k); out[o + 3] = 255; }
      else if (ctype === 0) { const g = sample(line, x) * scale; out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255; }
      else if (ctype === 4) { const g = sample(line, x * 2); out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = sample(line, x * 2 + 1); }
      else {
        const i = sample(line, x);
        out[o] = palette![i * 3]; out[o + 1] = palette![i * 3 + 1]; out[o + 2] = palette![i * 3 + 2];
        out[o + 3] = trns && i < trns.length ? trns[i] : 255;
      }
    }
  }
  return { width, height, data: out };
}
