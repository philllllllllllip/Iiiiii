// Noise primitives: ImprovedNoise, PerlinNoise (modern + legacy-for-blended), NormalNoise, BlendedNoise.
import type { RandomSource } from './random';

const GRAD = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1], [1, 1, 0], [0, -1, 1], [-1, 1, 0], [0, -1, -1]];
const GX = Float64Array.from(GRAD.map((g) => g[0])), GY = Float64Array.from(GRAD.map((g) => g[1])), GZ = Float64Array.from(GRAD.map((g) => g[2]));
const smooth = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (t: number, a: number, b: number) => a + t * (b - a);

export class ImprovedNoise {
  readonly p = new Uint8Array(256);
  readonly xo: number; readonly yo: number; readonly zo: number;
  constructor(r: RandomSource) {
    this.xo = r.nextDouble() * 256; this.yo = r.nextDouble() * 256; this.zo = r.nextDouble() * 256;
    for (let i = 0; i < 256; i++) this.p[i] = i;
    for (let i = 0; i < 256; i++) {
      const j = r.nextInt(256 - i);
      const t = this.p[i]; this.p[i] = this.p[i + j]; this.p[i + j] = t;
    }
  }
  noise(x: number, y: number, z: number, yScale = 0, yMax = 0): number {
    const d = x + this.xo, e = y + this.yo, f = z + this.zo;
    const i = Math.floor(d), j = Math.floor(e), k = Math.floor(f);
    const g = d - i, h = e - j, l = f - k;
    let o = 0;
    if (yScale !== 0) {
      const m = yMax >= 0 && yMax < h ? yMax : h;
      o = Math.floor(m / yScale + 1.0e-7) * yScale;
    }
    return this.sampleAndLerp(i, j, k, g, h - o, l, h);
  }
  private sampleAndLerp(i: number, j: number, k: number, x: number, y: number, z: number, yOrig: number): number {
    const p = this.p;
    const a = p[i & 255], b = p[(i + 1) & 255];
    const c = p[(a + j) & 255], d = p[(a + j + 1) & 255], e = p[(b + j) & 255], f = p[(b + j + 1) & 255];
    const dot = (hh: number, xx: number, yy: number, zz: number) => { const q = hh & 15; return GX[q] * xx + GY[q] * yy + GZ[q] * zz; };
    const g1 = dot(p[(c + k) & 255], x, y, z);
    const h1 = dot(p[(e + k) & 255], x - 1, y, z);
    const i1 = dot(p[(d + k) & 255], x, y - 1, z);
    const j1 = dot(p[(f + k) & 255], x - 1, y - 1, z);
    const k1 = dot(p[(c + k + 1) & 255], x, y, z - 1);
    const l1 = dot(p[(e + k + 1) & 255], x - 1, y, z - 1);
    const m1 = dot(p[(d + k + 1) & 255], x, y - 1, z - 1);
    const n1 = dot(p[(f + k + 1) & 255], x - 1, y - 1, z - 1);
    const sx = smooth(x), sy = smooth(yOrig), sz = smooth(z);
    return lerp(sz, lerp(sy, lerp(sx, g1, h1), lerp(sx, i1, j1)), lerp(sy, lerp(sx, k1, l1), lerp(sx, m1, n1)));
  }
}

export const wrap = (d: number) => d - Math.floor(d / 3.3554432e7 + 0.5) * 3.3554432e7;

export class PerlinNoise {
  readonly levels: (ImprovedNoise | null)[];
  readonly amplitudes: number[];
  readonly lowestFreqInputFactor: number;
  readonly lowestFreqValueFactor: number;
  readonly maxValue: number;

  private constructor(levels: (ImprovedNoise | null)[], amps: number[], firstOctave: number) {
    this.levels = levels; this.amplitudes = amps;
    const n = amps.length;
    this.lowestFreqInputFactor = Math.pow(2, firstOctave);
    this.lowestFreqValueFactor = Math.pow(2, n - 1) / (Math.pow(2, n) - 1);
    let mv = 0, f = this.lowestFreqValueFactor;
    for (let i = 0; i < n; i++) { if (levels[i]) mv += amps[i] * 2 * f; f /= 2; }
    this.maxValue = mv;
  }

  /** Modern construction: one ImprovedNoise per non-zero octave from fromHashOf("octave_N"). */
  static create(r: RandomSource, firstOctave: number, amps: number[]): PerlinNoise {
    const pf = r.forkPositional();
    const levels = amps.map((a, i) => (a !== 0 ? new ImprovedNoise(pf.fromHashOf('octave_' + (firstOctave + i))) : null));
    return new PerlinNoise(levels, amps, firstOctave);
  }

  /** PerlinNoise.createLegacyForBlendedNoise: sequential legacy construction for octaves [first..0]. */
  static createLegacy(r: RandomSource, firstOctave: number, amps: number[]): PerlinNoise {
    const i = -firstOctave, j = amps.length;
    const levels: (ImprovedNoise | null)[] = new Array(j).fill(null);
    const first = new ImprovedNoise(r);
    if (i >= 0 && i < j && amps[i] !== 0) levels[i] = first;
    for (let k = i - 1; k >= 0; k--) {
      if (k < j && amps[k] !== 0) levels[k] = new ImprovedNoise(r);
      else r.consumeCount(262);
    }
    return new PerlinNoise(levels, amps, firstOctave);
  }

  getValue(x: number, y: number, z: number): number {
    let d = 0, e = this.lowestFreqInputFactor, f = this.lowestFreqValueFactor;
    for (let i = 0; i < this.levels.length; i++) {
      const n = this.levels[i];
      if (n) d += this.amplitudes[i] * n.noise(wrap(x * e), wrap(y * e), wrap(z * e)) * f;
      e *= 2; f /= 2;
    }
    return d;
  }
  /** getOctaveNoise(i): octave i counted from the highest frequency. */
  octave(i: number): ImprovedNoise | null { return this.levels[this.levels.length - 1 - i]; }
}

export interface NoiseParams { base_octave: number; octave_count?: number; amplitude_modifiers?: number[]; base_amplitude: number }

const INPUT_FACTOR = 1.0181268882175227;

/** NormalNoise: two PerlinNoises sampled at slightly different frequencies (26.3 parameter format). */
export class NormalNoise {
  readonly first: PerlinNoise; readonly second: PerlinNoise;
  readonly valueFactor: number; readonly maxValue: number;
  constructor(r: RandomSource, p: NoiseParams) {
    const count = p.octave_count ?? p.amplitude_modifiers?.length ?? 1;
    const amps = (p.amplitude_modifiers ?? []).slice(0, count);
    while (amps.length < count) amps.push(1);
    this.first = PerlinNoise.create(r, p.base_octave, amps);
    this.second = PerlinNoise.create(r, p.base_octave, amps);
    // 26.3 stores a precomputed `base_amplitude`, but its companion PerlinNoise normalisation lives in
    // code we do not have (it ignores trailing zero octaves: [1,1] and [1,1,0,0,0,0] share one value).
    // Using it with the 1.21 PerlinNoise gave ~1.5% deep ocean and no mushroom fields, so the 1.21
    // NormalNoise factor (1/6)/expectedDeviation(octave span) is used instead (DEVIATIONS.md).
    let lo = -1, hi = -1;
    amps.forEach((a, i) => { if (a !== 0) { if (lo < 0) lo = i; hi = i; } });
    this.valueFactor = 0.16666666666666666 / (0.1 * (1 + 1 / (hi - lo + 1)));
    this.maxValue = (this.first.maxValue + this.second.maxValue) * this.valueFactor;
  }
  getValue(x: number, y: number, z: number): number {
    return (this.first.getValue(x, y, z) + this.second.getValue(x * INPUT_FACTOR, y * INPUT_FACTOR, z * INPUT_FACTOR)) * this.valueFactor;
  }
}

/** BlendedNoise (old_blended_noise): legacy 3D terrain noise. */
export class BlendedNoise {
  private minLimit: PerlinNoise; private maxLimit: PerlinNoise; private main: PerlinNoise;
  private xzMul: number; private yMul: number;
  constructor(r: RandomSource, readonly xzScale: number, readonly yScale: number, readonly xzFactor: number, readonly yFactor: number, readonly smear: number) {
    const ones = (n: number) => new Array(n).fill(1);
    this.minLimit = PerlinNoise.createLegacy(r, -15, ones(16));
    this.maxLimit = PerlinNoise.createLegacy(r, -15, ones(16));
    this.main = PerlinNoise.createLegacy(r, -7, ones(8));
    this.xzMul = 684.412 * xzScale; this.yMul = 684.412 * yScale;
  }
  compute(bx: number, by: number, bz: number): number {
    const d = bx * this.xzMul, e = by * this.yMul, f = bz * this.xzMul;
    const g = d / this.xzFactor, h = e / this.yFactor, i = f / this.xzFactor;
    const j = this.yMul * this.smear, k = j / this.yFactor;
    let n = 0, o = 0, p = 0, q = 1;
    for (let r = 0; r < 8; r++) {
      const nz = this.main.octave(r);
      if (nz) p += nz.noise(wrap(g * q), wrap(h * q), wrap(i * q), k * q, h * q) / q;
      q /= 2;
    }
    const s = (p / 10 + 1) / 2;
    const hi = s >= 1, lo = s <= 0;
    q = 1;
    for (let t = 0; t < 16; t++) {
      const u = wrap(d * q), v = wrap(e * q), w = wrap(f * q), x = j * q;
      if (!hi) { const nz = this.minLimit.octave(t); if (nz) n += nz.noise(u, v, w, x, e * q) / q; }
      if (!lo) { const nz = this.maxLimit.octave(t); if (nz) o += nz.noise(u, v, w, x, e * q) / q; }
      q /= 2;
    }
    const a = n / 512, b = o / 512;
    const cl = s < 0 ? a : s > 1 ? b : a + s * (b - a);
    return cl / 128;
  }
}
