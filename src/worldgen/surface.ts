// SurfaceRules (26.3 "material_rule") interpreter: conditions + rules referenced by id, evaluated per
// block of each column top-down with vanilla's stone-depth / water-height / surface-depth context.
import type { DensityContext } from './density';
import type { PositionalRandomFactory } from './random';
import { JavaRandom } from '../util/javarandom';

export interface SurfaceColumnCtx {
  x: number; z: number; y: number;
  biome: number;
  stoneDepthAbove: number; stoneDepthBelow: number; waterHeight: number;
  surfaceDepth: number; surfaceSecondary: number; minSurfaceLevel: number;
  steep: boolean;
}

type Cond = (c: SurfaceColumnCtx) => boolean;
type Rule = (c: SurfaceColumnCtx) => number; // -1 = no result

export interface SurfaceDeps {
  worldgen: Record<string, any>;
  density: DensityContext;
  random: PositionalRandomFactory;
  biomeId: (name: string) => number;
  state: (id: string, props?: Record<string, string>) => number;
  minY: number; height: number;
}

export class SurfaceSystem {
  readonly rule: Rule;
  private clayBands: number[] | null = null;
  private bandOffset: ReturnType<DensityContext['noise']>;
  constructor(readonly d: SurfaceDeps, root: any) {
    this.rule = this.compileRule(root);
    this.bandOffset = d.density.noise('clay_bands_offset');
  }

  private anchor(a: any): number {
    if ('absolute' in a) return a.absolute;
    if ('above_bottom' in a) return this.d.minY + a.above_bottom;
    if ('below_top' in a) return this.d.minY + this.d.height - 1 - a.below_top;
    throw new Error('bad anchor ' + JSON.stringify(a));
  }

  private ref(j: any, kind: 'material_rule' | 'material_condition'): any {
    if (typeof j === 'string') {
      const r = this.d.worldgen[kind + '/' + j.replace('minecraft:', '')];
      if (r === undefined) throw new Error(`missing ${kind} ${j}`);
      return r;
    }
    return j;
  }

  compileCond(j0: any): Cond {
    const j = this.ref(j0, 'material_condition');
    const t = String(j.type).replace('minecraft:', '');
    switch (t) {
      case 'biome': {
        const ids = new Set((Array.isArray(j.biome_is) ? j.biome_is : [j.biome_is]).map((b: string) => this.d.biomeId(b)));
        return (c) => ids.has(c.biome);
      }
      case 'stone_depth': {
        const ceil = j.surface_type === 'ceiling'; const off = j.offset ?? 0; const add = !!j.add_surface_depth; const range = j.secondary_depth_range ?? 0;
        return (c) => {
          const depth = ceil ? c.stoneDepthBelow : c.stoneDepthAbove;
          const sd = add ? c.surfaceDepth : 0;
          const sec = range === 0 ? 0 : Math.trunc(((c.surfaceSecondary + 1) / 2) * range);
          return depth <= 1 + off + sd + sec;
        };
      }
      case 'water': {
        const off = j.offset, mul = j.surface_depth_multiplier, add = !!j.add_stone_depth;
        return (c) => c.waterHeight === -2147483648 || c.y + (add ? c.stoneDepthAbove : 0) >= c.waterHeight + off + c.surfaceDepth * mul;
      }
      case 'y_above': {
        const a = this.anchor(j.anchor), mul = j.surface_depth_multiplier, add = !!j.add_stone_depth;
        return (c) => c.y + (add ? c.stoneDepthAbove : 0) >= a + c.surfaceDepth * mul;
      }
      case 'vertical_gradient': {
        const tr = this.anchor(j.true_at_and_below), fa = this.anchor(j.false_at_and_above);
        const rf = this.d.random.fromHashOf(j.random_name).forkPositional();
        return (c) => {
          if (c.y <= tr) return true;
          if (c.y >= fa) return false;
          const p = 1 - (c.y - tr) / (fa - tr);
          return rf.at(c.x, c.y, c.z).nextFloat() < p;
        };
      }
      case 'noise_threshold': {
        const n = this.d.density.noise(j.noise); const lo = j.min_threshold, hi = j.max_threshold;
        return (c) => { const v = n.getValue(c.x, 0, c.z); return v >= lo && v <= hi; };
      }
      case 'not': { const a = this.compileCond(j.invert); return (c) => !a(c); }
      case 'hole': return (c) => c.surfaceDepth <= 0;
      case 'steep': return (c) => c.steep;
      case 'above_preliminary_surface': return (c) => c.y >= c.minSurfaceLevel;
      case 'temperature': return () => false;
      default: throw new Error('unsupported material condition ' + t);
    }
  }

  compileRule(j0: any): Rule {
    const j = this.ref(j0, 'material_rule');
    const t = String(j.type).replace('minecraft:', '');
    switch (t) {
      case 'block': {
        const s = typeof j.result_state === 'string' ? this.d.state(j.result_state) : this.d.state(j.result_state.Name ?? j.result_state.id, j.result_state.Properties ?? j.result_state.properties);
        return () => s;
      }
      case 'sequence': {
        const rs: Rule[] = j.sequence.map((r: any) => this.compileRule(r));
        return (c) => { for (const r of rs) { const v = r(c); if (v >= 0) return v; } return -1; };
      }
      case 'condition': {
        const cond = this.compileCond(j.if_true), r = this.compileRule(j.then_run);
        return (c) => (cond(c) ? r(c) : -1);
      }
      case 'bandlands': {
        return (c) => this.band(c.x, c.y, c.z);
      }
      case 'ore_vein': {
        const dens = this.d.density.compile(j.density), rich = this.d.density.compile(j.richness), gap = this.d.density.compile(j.filler_gap);
        const ore = this.d.state(j.ore_block), raw = this.d.state(j.raw_ore_block), filler = this.d.state(j.filler_block);
        const chance = j.raw_ore_chance;
        const rf = this.d.random.fromHashOf('minecraft:ore_vein').forkPositional();
        return (c) => {
          // OreVeinifier: inside the vein band, richness decides ore vs filler, gap noise punches holes
          const v = dens(c.x, c.y, c.z);
          if (v <= 0) return -1;
          const r = rf.at(c.x, c.y, c.z);
          if (r.nextFloat() > rich(c.x, c.y, c.z) || gap(c.x, c.y, c.z) <= -0.3) return filler;
          return r.nextFloat() < chance ? raw : ore;
        };
      }
      default: throw new Error('unsupported material rule ' + t);
    }
  }

  /** SurfaceSystem.generateBands / getBand (badlands terracotta bands). */
  private band(x: number, y: number, z: number): number {
    if (!this.clayBands) this.clayBands = this.generateBands();
    const off = Math.round(this.bandOffset.getValue(x, 0, z) * 4);
    const i = (((y + off + this.clayBands.length) % this.clayBands.length) + this.clayBands.length) % this.clayBands.length;
    return this.clayBands[i];
  }
  private generateBands(): number[] {
    const r = this.d.random.fromHashOf('minecraft:clay_bands');
    const S = (n: string) => this.d.state(n);
    const T = S('terracotta');
    const bands = new Array(192).fill(T);
    for (let i = 0; i < bands.length; i++) {
      i += r.nextInt(5) + 1;
      if (i < bands.length) bands[i] = S('orange_terracotta');
    }
    const make = (rr: typeof r, count: number, minW: number, st: number) => {
      const n = rr.nextInt(4) + count;
      for (let k = 0; k < n; k++) {
        const w = rr.nextInt(minW) + 1 + (minW === 1 ? 0 : 0);
        const start = rr.nextInt(bands.length);
        for (let m = 0; start + m < bands.length && m < w; m++) bands[start + m] = st;
      }
    };
    make(r, 2, 1, S('yellow_terracotta'));
    make(r, 2, 2, S('brown_terracotta'));
    make(r, 2, 1, S('red_terracotta'));
    const whites = r.nextInt(9) + 9;
    let pos = 0;
    for (let k = 0; k < whites && pos < bands.length; k++) {
      pos += r.nextInt(16) + 4;
      for (let m = 0; pos + m < bands.length && m < 1; m++) {
        bands[pos + m] = S('white_terracotta');
        if (pos + m > 1 && r.nextBoolean()) bands[pos + m - 1] = S('light_gray_terracotta');
        if (pos + m < bands.length - 1 && r.nextBoolean()) bands[pos + m + 1] = S('light_gray_terracotta');
      }
    }
    return bands;
  }
}

export const NO_WATER = -2147483648;
export { JavaRandom };
