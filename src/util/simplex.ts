// net.minecraft.world.level.levelgen.synth.SimplexNoise (2D/3D), exact port.
import { JavaRandom } from './javarandom';

const GRADIENT = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1], [1, 1, 0], [0, -1, 1], [-1, 1, 0], [0, -1, -1]];
const SQRT_3 = Math.sqrt(3);
const F2 = 0.5 * (SQRT_3 - 1);
const G2 = (3 - SQRT_3) / 6;

export interface RandomLike { nextDouble(): number; nextInt(n: number): number }

export class SimplexNoise {
  readonly p = new Int32Array(512);
  readonly xo: number; readonly yo: number; readonly zo: number;
  constructor(r: RandomLike) {
    this.xo = r.nextDouble() * 256; this.yo = r.nextDouble() * 256; this.zo = r.nextDouble() * 256;
    for (let i = 0; i < 256; i++) this.p[i] = i;
    for (let i = 0; i < 256; i++) {
      const j = r.nextInt(256 - i);
      const t = this.p[i]; this.p[i] = this.p[j + i]; this.p[j + i] = t;
    }
  }
  private P(i: number): number { return this.p[i & 255]; }
  private corner(g: number, x: number, y: number, z: number, off: number): number {
    let t = off - x * x - y * y - z * z;
    if (t < 0) return 0;
    t *= t;
    const gr = GRADIENT[g];
    return t * t * (gr[0] * x + gr[1] * y + gr[2] * z);
  }
  getValue(x: number, y: number): number {
    const s = (x + y) * F2;
    const i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t), y0 = y - (j - t);
    let i1: number, j1: number;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    const g0 = this.P(ii + this.P(jj)) % 12;
    const g1 = this.P(ii + i1 + this.P(jj + j1)) % 12;
    const g2 = this.P(ii + 1 + this.P(jj + 1)) % 12;
    const n0 = this.corner(g0, x0, y0, 0, 0.5), n1 = this.corner(g1, x1, y1, 0, 0.5), n2 = this.corner(g2, x2, y2, 0, 0.5);
    return 70 * (n0 + n1 + n2);
  }
}

let biomeInfo: SimplexNoise | null = null;
/** Biome.BIOME_INFO_NOISE: PerlinSimplexNoise(LegacyRandomSource(2345), [0]).getValue(x, z, false) */
export function simplex2(x: number, z: number): number {
  if (!biomeInfo) biomeInfo = new SimplexNoise(new JavaRandom(2345n));
  return biomeInfo.getValue(x, z);
}
