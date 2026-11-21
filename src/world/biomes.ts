// Biome registry + colour providers (BiomeColors / GrassColor / FoliageColor / DryFoliageColor).
import type { RGBAImage } from '../assets/png';
import { Tint } from './blockinfo';
import { simplex2 } from '../util/simplex';

export interface BiomeDef {
  name: string; temperature: number; downfall: number; precipitation: boolean;
  grass: number; foliage: number; dryFoliage: number; water: number;
  grassModifier: 'none' | 'swamp' | 'dark_forest';
  attributes: Record<string, any>;
  temperatureModifier?: string;
}

const hex = (s: string | undefined): number | undefined => (s === undefined ? undefined : parseInt(s.replace('#', ''), 16) & 0xffffff);

function colormap(img: RGBAImage, temp: number, down: number): number {
  const t = Math.min(1, Math.max(0, temp));
  const d = Math.min(1, Math.max(0, down)) * t;
  const i = Math.floor((1 - t) * 255), j = Math.floor((1 - d) * 255);
  const k = (j << 8) | i;
  if (k >= img.width * img.height) return 0xff00ff;
  return (img.data[k * 4] << 16) | (img.data[k * 4 + 1] << 8) | img.data[k * 4 + 2];
}

export class Biomes {
  readonly list: BiomeDef[] = [];
  readonly byName = new Map<string, number>();
  constructor(worldgen: Record<string, any>, grass: RGBAImage, foliage: RGBAImage, dry: RGBAImage) {
    const names = Object.keys(worldgen).filter((k) => k.startsWith('biome/')).map((k) => k.slice(6)).sort();
    for (const name of names) {
      const j = worldgen['biome/' + name];
      const e = j.effects ?? {};
      const def: BiomeDef = {
        name, temperature: j.temperature, downfall: j.downfall, precipitation: j.has_precipitation,
        grass: hex(e.grass_color) ?? colormap(grass, j.temperature, j.downfall),
        foliage: hex(e.foliage_color) ?? colormap(foliage, j.temperature, j.downfall),
        dryFoliage: hex(e.dry_foliage_color) ?? colormap(dry, j.temperature, j.downfall),
        water: hex(e.water_color) ?? 0x3f76e4,
        grassModifier: e.grass_color_modifier ?? 'none',
        attributes: j.attributes ?? {},
        temperatureModifier: j.temperature_modifier,
      };
      this.byName.set(name, this.list.length);
      this.list.push(def);
    }
  }
  id(name: string): number {
    const i = this.byName.get(name.replace(/^minecraft:/, ''));
    if (i === undefined) throw new Error('unknown biome ' + name);
    return i;
  }

  /** Grass colour at a position, with the biome's grass_color_modifier. */
  grassAt(b: number, x: number, z: number): number {
    const def = this.list[b];
    switch (def.grassModifier) {
      case 'swamp': return simplex2(x * 0.0225, z * 0.0225) < -0.1 ? 0x4c763c : 0x6a7039;
      case 'dark_forest': return (((def.grass & 0xfefefe) + 0x28340a) >> 1);
      default: return def.grass;
    }
  }

  /** Colour for a tint source at a position for biome b. */
  color(kind: Tint, b: number, x: number, z: number): number {
    const def = this.list[b];
    switch (kind) {
      case Tint.Grass: case Tint.GrassSecondary: return this.grassAt(b, x, z);
      case Tint.Foliage: return def.foliage;
      case Tint.DryFoliage: return def.dryFoliage;
      case Tint.Water: return def.water;
      case Tint.Evergreen: return 0x619961;
      case Tint.Birch: return 0x80a755;
      case Tint.LilyPad: return 0x208030;
      case Tint.AttachedStem: return 0xe0c71c;
      default: return 0xffffff;
    }
  }
}

/** RedStoneWireBlock.getColorForPower */
export function redstoneColor(power: number): number {
  const f = power / 15;
  const r = f * 0.6 + (f > 0 ? 0.4 : 0.3);
  const g = Math.min(1, Math.max(0, f * f * 0.7 - 0.5));
  const b = Math.min(1, Math.max(0, f * f * 0.6 - 0.7));
  return (Math.floor(r * 255) << 16) | (Math.floor(g * 255) << 8) | Math.floor(b * 255);
}
/** StemBlock colour by age */
export function stemColor(age: number): number {
  return ((age * 32) << 16) | ((255 - age * 8) << 8) | (age * 4);
}
