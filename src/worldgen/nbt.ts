// Named Binary Tag reader (gzip-compressed, big-endian) for structure templates.
import { gunzipSync } from 'fflate';

export type Nbt = number | bigint | string | Nbt[] | { [k: string]: Nbt } | Int8Array | Int32Array | BigInt64Array;

export function readNbt(data: Uint8Array): { [k: string]: Nbt } {
  const buf = data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data) : data;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const str = () => { const n = dv.getUint16(p); p += 2; const s = new TextDecoder().decode(buf.subarray(p, p + n)); p += n; return s; };
  const payload = (t: number): Nbt => {
    switch (t) {
      case 1: return dv.getInt8(p++);
      case 2: { const v = dv.getInt16(p); p += 2; return v; }
      case 3: { const v = dv.getInt32(p); p += 4; return v; }
      case 4: { const v = dv.getBigInt64(p); p += 8; return v; }
      case 5: { const v = dv.getFloat32(p); p += 4; return v; }
      case 6: { const v = dv.getFloat64(p); p += 8; return v; }
      case 7: { const n = dv.getInt32(p); p += 4; const a = new Int8Array(buf.buffer, buf.byteOffset + p, n).slice(); p += n; return a; }
      case 8: return str();
      case 9: { const et = dv.getUint8(p++); const n = dv.getInt32(p); p += 4; const a: Nbt[] = []; for (let i = 0; i < n; i++) a.push(payload(et)); return a; }
      case 10: { const o: { [k: string]: Nbt } = {}; for (;;) { const tt = dv.getUint8(p++); if (tt === 0) break; const name = str(); o[name] = payload(tt); } return o; }
      case 11: { const n = dv.getInt32(p); p += 4; const a = new Int32Array(n); for (let i = 0; i < n; i++) { a[i] = dv.getInt32(p); p += 4; } return a; }
      case 12: { const n = dv.getInt32(p); p += 4; const a = new BigInt64Array(n); for (let i = 0; i < n; i++) { a[i] = dv.getBigInt64(p); p += 8; } return a; }
      default: throw new Error('bad NBT tag ' + t);
    }
  };
  const t = dv.getUint8(p++);
  if (t !== 10) throw new Error('NBT root is not a compound');
  str();
  return payload(10) as { [k: string]: Nbt };
}
