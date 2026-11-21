// Biome temperature / precipitation (net.minecraft.world.level.biome.Biome), exact port:
// TEMPERATURE_NOISE = PerlinSimplexNoise(Legacy(1234), [0]), FROZEN_TEMPERATURE_NOISE = (Legacy(3456), [-2,-1,0]),
// BIOME_INFO_NOISE = (Legacy(2345), [0]).
import { SimplexNoise, simplex2 } from '../util/simplex';
import { JavaRandom } from '../util/javarandom';
import type { BiomeDef } from './biomes';

/** PerlinSimplexNoise for a contiguous octave list ending at 0 (first octave = -(n-1)). */
class PerlinSimplex {
  private levels: SimplexNoise[] = [];
  private inFactor: number; private valFactor: number;
  constructor(seed: bigint, octaves: number) {
    const r = new JavaRandom(seed);
    for (let i = 0; i < octaves; i++) this.levels.push(new SimplexNoise(r));
    this.inFactor = 1; this.valFactor = 1 / (2 ** octaves - 1);
  }
  getValue(x: number, z: number): number {
    let d = 0, e = this.inFactor, f = this.valFactor;
    for (const n of this.levels) { d += n.getValue(x * e, z * e) * f; e /= 2; f *= 2; }
    return d;
  }
}

let tempNoise: SimplexNoise | null = null;
let frozenNoise: PerlinSimplex | null = null;

/** Biome.getHeightAdjustedTemperature(pos, seaLevel) including the FROZEN temperature modifier. */
export function biomeTemperature(def: BiomeDef, x: number, y: number, z: number, seaLevel = 63): number {
  let t = def.temperature;
  if (def.temperatureModifier === 'frozen') {
    frozenNoise ??= new PerlinSimplex(3456n, 3);
    const d = frozenNoise.getValue(x * 0.05, z * 0.05) * 7 + simplex2(x * 0.2, z * 0.2);
    if (d < 0.3 && simplex2(x * 0.09, z * 0.09) < 0.8) t = 0.2;
  }
  if (y > seaLevel + 17) {
    tempNoise ??= new SimplexNoise(new JavaRandom(1234n));
    const f = Math.fround(tempNoise.getValue(x / 8, z / 8) * 8);
    t = Math.fround(t - Math.fround(Math.fround(f + y - (seaLevel + 17)) * 0.05) / 40);
  }
  return t;
}

export type Precipitation = 'none' | 'rain' | 'snow';
/** Biome.getPrecipitationAt */
export function precipitationAt(def: BiomeDef, x: number, y: number, z: number, seaLevel = 63): Precipitation {
  if (!def.precipitation) return 'none';
  return biomeTemperature(def, x, y, z, seaLevel) < 0.15 ? 'snow' : 'rain';
}
