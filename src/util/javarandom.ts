// java.util.Random (LegacyRandomSource) — 48-bit LCG, exact. State held as two 24-bit limbs so all
// arithmetic stays within double precision without BigInt in the hot path.
const M_LO = 0xece66d, M_HI = 0x5de; // 0x5DEECE66D
const P24 = 0x1000000;

export class JavaRandom {
  private hi = 0; private lo = 0;
  private nextNextGaussian = 0; private haveNextNextGaussian = false;
  constructor(seed: bigint | number = 0n) { this.setSeed(seed); }

  setSeed(seed: bigint | number): void {
    const s = (BigInt.asUintN(48, BigInt(seed)) ^ 0x5deece66dn) & 0xffffffffffffn;
    this.hi = Number(s >> 24n); this.lo = Number(s & 0xffffffn);
    this.haveNextNextGaussian = false;
  }
  /** Returns next(bits) as a signed 32-bit int like Java. */
  next(bits: number): number {
    const lo = this.lo * M_LO + 0xb;
    const mid = this.hi * M_LO + this.lo * M_HI + Math.floor(lo / P24);
    this.lo = lo % P24;
    this.hi = mid % P24;
    // seed >>> (48 - bits), seed = hi*2^24 + lo
    const shift = 48 - bits;
    let r: number;
    if (shift >= 24) r = Math.floor(this.hi / 2 ** (shift - 24));
    else r = this.hi * 2 ** (24 - shift) + Math.floor(this.lo / 2 ** shift);
    return r | 0;
  }
  nextInt(bound?: number): number {
    if (bound === undefined) return this.next(32);
    if (bound <= 0) throw new Error('bound must be positive');
    if ((bound & -bound) === bound) return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
    let bits: number, val: number;
    do { bits = this.next(31); val = bits % bound; } while (bits - val + (bound - 1) > 0x7fffffff);
    return val;
  }
  nextLong(): bigint { return BigInt.asIntN(64, (BigInt(this.next(32)) << 32n) + BigInt(this.next(32))); }
  nextBoolean(): boolean { return this.next(1) !== 0; }
  nextFloat(): number { return this.next(24) / P24; }
  nextDouble(): number { return ((this.next(26) >>> 0) * 2 ** 27 + (this.next(27) >>> 0)) * 2 ** -53; }
  nextGaussian(): number {
    if (this.haveNextNextGaussian) { this.haveNextNextGaussian = false; return this.nextNextGaussian; }
    let v1: number, v2: number, s: number;
    do { v1 = 2 * this.nextDouble() - 1; v2 = 2 * this.nextDouble() - 1; s = v1 * v1 + v2 * v2; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    this.nextNextGaussian = v2 * m; this.haveNextNextGaussian = true;
    return v1 * m;
  }
}

/** Mth.getSeed(x, y, z) — positional seed used for model variant selection and offsets. */
export function getSeed(x: number, y: number, z: number): bigint {
  let l = BigInt.asIntN(64, BigInt(Math.imul(x, 3129871)) ^ (BigInt(z) * 116129781n) ^ BigInt(y));
  l = BigInt.asIntN(64, l * l * 42317861n + l * 11n);
  return l >> 16n;
}
