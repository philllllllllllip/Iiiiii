// Xoroshiro128++ random sources as used by 1.18+ world generation (XoroshiroRandomSource,
// XoroshiroPositionalRandomFactory, RandomSupport), plus LegacyRandomSource adapters.
import { md5 } from './md5';
import { getSeed } from '../util/javarandom';

const M64 = (1n << 64n) - 1n;
const u64 = (v: bigint) => v & M64;
const SILVER = 0x6a09e667f3bcc909n, GOLDEN = 0x9e3779b97f4a7c15n;

export function mixStafford13(l: bigint): bigint {
  l = u64((l ^ (l >> 30n)) * 0xbf58476d1ce4e5b9n);
  l = u64((l ^ (l >> 27n)) * 0x94d049bb133111ebn);
  return l ^ (l >> 31n);
}

export interface RandomSource {
  nextLong(): bigint; nextInt(bound?: number): number; nextDouble(): number; nextFloat(): number;
  nextBoolean(): boolean; nextGaussian(): number; consumeCount(n: number): void;
  forkPositional(): PositionalRandomFactory; fork(): RandomSource;
}
export interface PositionalRandomFactory {
  at(x: number, y: number, z: number): RandomSource;
  fromHashOf(name: string): RandomSource;
}

/** Xoroshiro128++ on 32-bit limbs (exact 64-bit semantics without BigInt in the hot path). */
export class Xoroshiro implements RandomSource {
  private a1 = 0; private a0 = 0; private b1 = 0; private b0 = 0; // lo = a1:a0, hi = b1:b0
  private nextNextGaussian = 0; private haveGaussian = false;
  constructor(lo: bigint, hi: bigint) { this.set(lo, hi); }
  set(lo: bigint, hi: bigint): void {
    lo = u64(lo); hi = u64(hi);
    if (lo === 0n && hi === 0n) { lo = GOLDEN; hi = SILVER; }
    this.a1 = Number(lo >> 32n) >>> 0; this.a0 = Number(lo & 0xffffffffn) >>> 0;
    this.b1 = Number(hi >> 32n) >>> 0; this.b0 = Number(hi & 0xffffffffn) >>> 0;
    this.haveGaussian = false;
  }
  get lo(): bigint { return (BigInt(this.a1) << 32n) | BigInt(this.a0); }
  get hi(): bigint { return (BigInt(this.b1) << 32n) | BigInt(this.b0); }
  static fromSeed(seed: bigint): Xoroshiro {
    const lo = u64(seed) ^ SILVER;
    const hi = u64(lo + GOLDEN);
    return new Xoroshiro(mixStafford13(lo), mixStafford13(hi));
  }
  setSeed(seed: bigint): void {
    const lo = u64(seed) ^ SILVER;
    this.set(mixStafford13(lo), mixStafford13(u64(lo + GOLDEN)));
  }
  // result of the last step
  private r1 = 0; private r0 = 0;
  private step(): void {
    const l1 = this.a1, l0 = this.a0; let m1 = this.b1, m0 = this.b0;
    // s = l + m
    let s0 = l0 + m0; const c = s0 > 0xffffffff ? 1 : 0; s0 >>>= 0; const s1 = (l1 + m1 + c) >>> 0;
    // rotl(s, 17)
    const t1 = ((s1 << 17) | (s0 >>> 15)) >>> 0, t0 = ((s0 << 17) | (s1 >>> 15)) >>> 0;
    // n = rotl(s,17) + l
    let n0 = t0 + l0; const c2 = n0 > 0xffffffff ? 1 : 0; n0 >>>= 0;
    this.r1 = (t1 + l1 + c2) >>> 0; this.r0 = n0;
    m1 = (m1 ^ l1) >>> 0; m0 = (m0 ^ l0) >>> 0;
    // rotl(l, 49) = rotl(swap(l), 17)
    const q1 = ((l0 << 17) | (l1 >>> 15)) >>> 0, q0 = ((l1 << 17) | (l0 >>> 15)) >>> 0;
    // m << 21
    const sh1 = ((m1 << 21) | (m0 >>> 11)) >>> 0, sh0 = (m0 << 21) >>> 0;
    this.a1 = (q1 ^ m1 ^ sh1) >>> 0; this.a0 = (q0 ^ m0 ^ sh0) >>> 0;
    // rotl(m, 28)
    this.b1 = ((m1 << 28) | (m0 >>> 4)) >>> 0; this.b0 = ((m0 << 28) | (m1 >>> 4)) >>> 0;
  }
  nextU64(): bigint { this.step(); return (BigInt(this.r1) << 32n) | BigInt(this.r0); }
  nextLong(): bigint { return BigInt.asIntN(64, this.nextU64()); }
  nextInt(bound?: number): number {
    this.step();
    if (bound === undefined) return this.r0 | 0;
    if (bound <= 0) throw new Error('bound must be positive');
    let l = this.r0;
    let [hiP, loP] = mul32(l, bound);
    if (loP < bound) {
      const j = (((~bound + 1) >>> 0) % bound) >>> 0;
      while (loP < j) { this.step(); l = this.r0; [hiP, loP] = mul32(l, bound); }
    }
    return hiP | 0;
  }
  nextDouble(): number { this.step(); return (this.r1 * 2097152 + (this.r0 >>> 11)) * 1.1102230246251565e-16; }
  nextFloat(): number { this.step(); return (this.r1 >>> 8) * 5.9604645e-8; }
  nextBoolean(): boolean { this.step(); return (this.r0 & 1) !== 0; }
  nextGaussian(): number {
    if (this.haveGaussian) { this.haveGaussian = false; return this.nextNextGaussian; }
    for (;;) {
      const d = 2 * this.nextDouble() - 1, e = 2 * this.nextDouble() - 1;
      const f = d * d + e * e;
      if (f < 1 && f !== 0) {
        const g = Math.sqrt(-2 * Math.log(f) / f);
        this.nextNextGaussian = e * g; this.haveGaussian = true;
        return d * g;
      }
    }
  }
  consumeCount(n: number): void { for (let i = 0; i < n; i++) this.step(); }
  forkPositional(): PositionalRandomFactory { return new XoroshiroPositional(this.nextU64(), this.nextU64()); }
  fork(): RandomSource { return new Xoroshiro(this.nextU64(), this.nextU64()); }
}

/** 32x32 -> 64-bit unsigned product as [high32, low32], exact. */
function mul32(a: number, b: number): [number, number] {
  const ah = a >>> 16, al = a & 0xffff;
  const lo = al * b, hi = ah * b; // each < 2^47
  const mid = (hi % 65536) * 65536 + lo; // < 2^48 + 2^47
  return [Math.floor(hi / 65536) + Math.floor(mid / 4294967296), mid % 4294967296];
}

export class XoroshiroPositional implements PositionalRandomFactory {
  constructor(readonly lo: bigint, readonly hi: bigint) {}
  at(x: number, y: number, z: number): Xoroshiro {
    return new Xoroshiro(u64(getSeed(x, y, z)) ^ this.lo, this.hi);
  }
  fromHashOf(name: string): Xoroshiro {
    const h = md5(name);
    let a = 0n, b = 0n;
    for (let i = 0; i < 8; i++) { a = (a << 8n) | BigInt(h[i]); b = (b << 8n) | BigInt(h[i + 8]); }
    return new Xoroshiro(a ^ this.lo, b ^ this.hi);
  }
}

/** Parse a seed string the way the world creation screen does (number, else String.hashCode). */
export function parseSeed(text: string): bigint {
  const t = text.trim();
  if (t === '') {
    const r = crypto.getRandomValues(new Uint32Array(2));
    return BigInt.asIntN(64, (BigInt(r[0]) << 32n) | BigInt(r[1]));
  }
  if (/^-?\d+$/.test(t)) {
    const v = BigInt(t);
    if (v >= -(1n << 63n) && v < (1n << 63n)) return v;
  }
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (Math.imul(31, h) + t.charCodeAt(i)) | 0;
  return BigInt(h);
}
