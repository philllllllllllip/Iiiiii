// Configured/placed feature engine for 26.3 worldgen JSON.
// Placement modifiers, block predicates, block state providers, int/float/height providers and the
// common feature types are implemented; feature types not implemented are listed in DEVIATIONS.md
// and skipped (never replaced by invented content).
import type { BlockRegistry } from '../world/registry';
import type { RandomSource } from './random';
import type { DensityContext } from './density';

export interface GenAccess {
  get(x: number, y: number, z: number): number;
  set(x: number, y: number, z: number, s: number): void;
  height(kind: string, x: number, z: number): number; // first free y above the heightmap surface
  biome(x: number, y: number, z: number): number;
  inBounds(x: number, z: number): boolean;
  minY: number; maxY: number; seaLevel: number;
}

export class Tags {
  private cache = new Map<string, Set<number>>();
  constructor(readonly tags: Record<string, { values: (string | { id: string; required?: boolean })[] }>, readonly reg: BlockRegistry) {}
  /** Block tag -> set of block indices. */
  block(tag: string): Set<number> {
    tag = tag.replace(/^#/, '').replace('minecraft:', '');
    let s = this.cache.get(tag);
    if (s) return s;
    s = new Set();
    this.cache.set(tag, s);
    const t = this.tags['block/' + tag];
    if (!t) return s;
    for (const v0 of t.values) {
      const v = typeof v0 === 'string' ? v0 : v0.id;
      if (v.startsWith('#')) for (const b of this.block(v)) s.add(b);
      else { const i = this.reg.byName.get(v.replace('minecraft:', '')); if (i !== undefined) s.add(i); }
    }
    return s;
  }
  has(tag: string, state: number): boolean { return this.block(tag).has(this.reg.stateBlock[state]); }
}

// ---------------------------------------------------------------------------------------------
// value providers
// ---------------------------------------------------------------------------------------------
export function sampleInt(j: any, r: RandomSource): number {
  if (typeof j === 'number') return j;
  const t = String(j.type).replace('minecraft:', '');
  switch (t) {
    case 'constant': return j.value;
    case 'uniform': { const lo = j.min_inclusive ?? j.value?.min_inclusive, hi = j.max_inclusive ?? j.value?.max_inclusive; return lo + r.nextInt(hi - lo + 1); }
    case 'biased_to_bottom': { const lo = j.min_inclusive, hi = j.max_inclusive; return lo + r.nextInt(r.nextInt(hi - lo + 1) + 1); }
    case 'clamped': return Math.min(j.max_inclusive, Math.max(j.min_inclusive, sampleInt(j.source, r)));
    case 'clamped_normal': { const v = j.mean + r.nextGaussian() * j.deviation; return Math.floor(Math.min(j.max_inclusive, Math.max(j.min_inclusive, v))); }
    case 'trapezoid': { const lo = j.min, hi = j.max, pl = j.plateau ?? 0; const range = hi - lo; const s = (range - pl) / 2; const k = range - s; return lo + r.nextInt(k + 1) + r.nextInt(s + 1) - 0 * pl; }
    case 'weighted_list': {
      let total = 0; for (const e of j.distribution) total += e.weight;
      let p = r.nextInt(total);
      for (const e of j.distribution) { p -= e.weight; if (p < 0) return sampleInt(e.data, r); }
      return 0;
    }
    default: throw new Error('unsupported int provider ' + t);
  }
}
export function sampleFloat(j: any, r: RandomSource): number {
  if (typeof j === 'number') return j;
  const t = String(j.type).replace('minecraft:', '');
  switch (t) {
    case 'constant': return j.value;
    case 'uniform': return j.min_inclusive + r.nextFloat() * (j.max_exclusive - j.min_inclusive);
    case 'trapezoid': { const range = j.max - j.min; const s = (range - j.plateau) / 2; const k = range - s; return j.min + r.nextFloat() * k + r.nextFloat() * s; }
    case 'clamped_normal': return Math.min(j.max, Math.max(j.min, j.mean + r.nextGaussian() * j.deviation));
    default: throw new Error('unsupported float provider ' + t);
  }
}

export class Engine {
  readonly reg: BlockRegistry;
  private noiseCache = new Map<string, any>();
  stats = new Map<string, number>();

  constructor(reg: BlockRegistry, readonly worldgen: Record<string, any>, readonly tags: Tags, readonly density: DensityContext,
    readonly biomeId: (n: string) => number, readonly biomeFeatures: (biome: number) => Set<string>) {
    this.reg = reg;
  }

  // ------------------------------------------------------------------ helpers
  stateOf(j: any): number {
    if (typeof j === 'string') return this.reg.state(j);
    const name = j.id ?? j.Name; const props = j.properties ?? j.Properties ?? {};
    let s = this.reg.defaultState(name);
    for (const [k, v] of Object.entries(props)) if (this.reg.hasProp(s, k)) s = this.reg.withProp(s, k, String(v));
    return s;
  }
  isAir(s: number): boolean { return s === 0 || this.reg.name(s).endsWith('_air'); }

  anchorY(a: any, g: GenAccess): number {
    if ('absolute' in a) return a.absolute;
    if ('above_bottom' in a) return g.minY + a.above_bottom;
    if ('below_top' in a) return g.maxY - 1 - a.below_top;
    throw new Error('bad anchor');
  }
  sampleHeight(j: any, r: RandomSource, g: GenAccess): number {
    const t = String(j.type ?? 'constant').replace('minecraft:', '');
    if (!j.type) return this.anchorY(j, g);
    switch (t) {
      case 'constant': return this.anchorY(j.value, g);
      case 'uniform': { const lo = this.anchorY(j.min_inclusive, g), hi = this.anchorY(j.max_inclusive, g); return hi < lo ? lo : lo + r.nextInt(hi - lo + 1); }
      case 'biased_to_bottom': { const lo = this.anchorY(j.min_inclusive, g), hi = this.anchorY(j.max_inclusive, g); const inner = j.inner ?? 1; return lo + r.nextInt(r.nextInt(hi - lo - inner + 1) + inner); }
      case 'very_biased_to_bottom': { const lo = this.anchorY(j.min_inclusive, g), hi = this.anchorY(j.max_inclusive, g); const inner = j.inner ?? 1; const a = r.nextInt(hi - lo - inner + 1) + lo + inner; const b = r.nextInt(a - lo - inner + 1) + lo + inner; return lo + r.nextInt(b - lo) ; }
      case 'trapezoid': {
        const lo = this.anchorY(j.min_inclusive, g), hi = this.anchorY(j.max_inclusive, g); const pl = j.plateau ?? 0;
        if (lo > hi) return lo;
        const k = hi - lo; if (pl >= k) return lo + r.nextInt(k + 1);
        const l = (k - pl) / 2 | 0, m = k - l;
        return lo + r.nextInt(m + 1) + r.nextInt(l + 1);
      }
      default: throw new Error('unsupported height provider ' + t);
    }
  }

  private provCache = new WeakMap<object, any>();
  private predCache = new WeakMap<object, any>();
  private provStr = new Map<string, any>();
  provider(j: any): (r: RandomSource, x: number, y: number, z: number, g: GenAccess) => number {
    if (typeof j === 'object' && j) { let f = this.provCache.get(j); if (!f) { f = this.provider0(j); this.provCache.set(j, f); } return f; }
    let f = this.provStr.get(j); if (!f) { f = this.provider0(j); this.provStr.set(j, f); } return f;
  }
  private provider0(j: any): (r: RandomSource, x: number, y: number, z: number, g: GenAccess) => number {
    if (typeof j === 'string') {
      const ref = this.worldgen['block_state_provider/' + j.replace('minecraft:', '')];
      if (ref) return this.provider(ref);
      const s = this.reg.state(j); return () => s;
    }
    if (!j.type) { const s = this.stateOf(j); return () => s; }
    const t = String(j.type).replace('minecraft:', '');
    switch (t) {
      case 'simple_state_provider': { const s = this.stateOf(j.state); return () => s; }
      case 'weighted': {
        const ents = (j.entries ?? j.distribution).map((e: any) => ({ s: this.stateOf(e.data), w: e.weight }));
        const total = ents.reduce((a: number, e: any) => a + e.w, 0);
        return (r) => { let p = r.nextInt(total); for (const e of ents) { p -= e.w; if (p < 0) return e.s; } return ents[0].s; };
      }
      case 'random_block': {
        const list = (typeof j.blocks === 'string' && j.blocks.startsWith('#') ? [...this.tags.block(j.blocks)].sort((a, b) => a - b) : (Array.isArray(j.blocks) ? j.blocks : [j.blocks]).map((b: string) => this.reg.byName.get(b.replace('minecraft:', ''))!))
          .map((bi: number) => this.reg.blocks[bi].def);
        return (r) => list[r.nextInt(list.length)];
      }
      case 'rotated': {
        const base = this.stateOf(j.state);
        return (r) => { const ax = ['x', 'y', 'z'][r.nextInt(3)]; return this.reg.hasProp(base, 'axis') ? this.reg.withProp(base, 'axis', ax) : base; };
      }
      case 'randomized_int': {
        const src = this.provider(j.source); const prop = j.property; const vals = j.values;
        return (r, x, y, z, g) => { const s = src(r, x, y, z, g); return this.reg.hasProp(s, prop) ? this.reg.withProp(s, prop, String(sampleInt(vals, r))) : s; };
      }
      case 'noise_threshold': case 'noise': case 'dual_noise': {
        const states = (j.states ?? [j.default_state]).map((s: any) => this.stateOf(s));
        const low = (j.low_states ?? []).map((s: any) => this.stateOf(s)), high = (j.high_states ?? []).map((s: any) => this.stateOf(s));
        const def = j.default_state ? this.stateOf(j.default_state) : states[0];
        const noise = this.density.noise(typeof j.noise === 'string' ? j.noise : 'surface');
        const scale = j.scale ?? 1;
        return (r, x, _y, z) => {
          const v = noise.getValue(x * scale, 0, z * scale);
          if (t === 'noise_threshold') {
            if (v < j.threshold) return low[r.nextInt(low.length)] ?? def;
            return r.nextFloat() < j.high_chance ? high[r.nextInt(high.length)] : def;
          }
          const i = Math.min(states.length - 1, Math.max(0, Math.floor(((v + 1) / 2) * states.length)));
          return states[i];
        };
      }
      case 'rule_based': {
        const rules = j.rules.map((rl: any) => ({ p: this.predicate(rl.if_true), s: this.provider(rl.then) }));
        const fb = j.fallback ? this.provider(j.fallback) : null;
        return (r, x, y, z, g) => { for (const rl of rules) if (rl.p(g, x, y, z)) return rl.s(r, x, y, z, g); return fb ? fb(r, x, y, z, g) : -1; };
      }
      default: throw new Error('unsupported block state provider ' + t);
    }
  }

  predicate(j: any): (g: GenAccess, x: number, y: number, z: number) => boolean {
    let f = this.predCache.get(j); if (!f) { f = this.predicate0(j); this.predCache.set(j, f); } return f;
  }
  private predicate0(j: any): (g: GenAccess, x: number, y: number, z: number) => boolean {
    const t = String(j.type).replace('minecraft:', '');
    const off = j.offset ?? [0, 0, 0];
    const at = (g: GenAccess, x: number, y: number, z: number) => g.get(x + off[0], y + off[1], z + off[2]);
    switch (t) {
      case 'true': return () => true;
      case 'not': { const p = this.predicate(j.predicate); return (g, x, y, z) => !p(g, x, y, z); }
      case 'all_of': { const ps = j.predicates.map((p: any) => this.predicate(p)); return (g, x, y, z) => ps.every((p: any) => p(g, x, y, z)); }
      case 'any_of': { const ps = j.predicates.map((p: any) => this.predicate(p)); return (g, x, y, z) => ps.some((p: any) => p(g, x, y, z)); }
      case 'matching_blocks': {
        const bl = new Set((Array.isArray(j.blocks) ? j.blocks : [j.blocks]).flatMap((b: string) => (b.startsWith('#') ? [...this.tags.block(b)] : [this.reg.byName.get(b.replace('minecraft:', ''))])));
        return (g, x, y, z) => bl.has(this.reg.stateBlock[at(g, x, y, z)]);
      }
      case 'matching_block_tag': { const s = this.tags.block(j.tag); return (g, x, y, z) => s.has(this.reg.stateBlock[at(g, x, y, z)]); }
      case 'matching_fluids': {
        const fl = (Array.isArray(j.fluids) ? j.fluids : [j.fluids]).map((f: string) => f.replace('minecraft:', ''));
        const water = fl.some((f: string) => f.includes('water')), lava = fl.some((f: string) => f.includes('lava'));
        return (g, x, y, z) => { const n = this.reg.name(at(g, x, y, z)); return (water && n === 'water') || (lava && n === 'lava'); };
      }
      case 'solid': return (g, x, y, z) => this.solid(at(g, x, y, z));
      case 'replaceable': return (g, x, y, z) => this.tags.has('replaceable', at(g, x, y, z));
      case 'has_sturdy_face': return (g, x, y, z) => this.solid(at(g, x, y, z));
      case 'would_survive': { const s = this.stateOf(j.state); return (g, x, y, z) => this.canSurvive(s, g, x + off[0], y + off[1], z + off[2]); }
      case 'inside_world_bounds': return (g, _x, y) => y >= g.minY && y < g.maxY;
      case 'volume_match': return () => true;
      default: throw new Error('unsupported block predicate ' + t);
    }
  }

  solid(s: number): boolean {
    if (s === 0) return false;
    const n = this.reg.name(s);
    return !(n.endsWith('air') || n === 'water' || n === 'lava' || this.tags.has('replaceable', s) || n.includes('flower') || n.includes('sapling'));
  }

  /** BlockState.canSurvive for generated vegetation, using 26.3 supports_* tags. */
  canSurvive(s: number, g: GenAccess, x: number, y: number, z: number): boolean {
    const name = this.reg.name(s);
    const below = g.get(x, y - 1, z);
    const sup = (tag: string) => this.tags.has(tag, below);
    if (this.tags.has('saplings', s) || /^(short_grass|fern|tall_grass|large_fern|bush|sweet_berry_bush|.*_tulip|poppy|dandelion|cornflower|allium|azure_bluet|blue_orchid|oxeye_daisy|lily_of_the_valley|sunflower|lilac|rose_bush|peony|pink_petals|wildflowers|firefly_bush|leaf_litter|torchflower|open_eyeblossom|closed_eyeblossom|pumpkin|melon)$/.test(name)) return sup('supports_vegetation');
    if (name === 'sugar_cane') {
      if (this.reg.name(below) === 'sugar_cane') return true;
      if (!sup('supports_sugar_cane')) return false;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = this.reg.name(g.get(x + dx, y - 1, z + dz)); if (n === 'water' || n === 'frosted_ice') return true; }
      return false;
    }
    if (name === 'cactus') {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (this.solid(g.get(x + dx, y, z + dz))) return false;
      return sup('supports_cactus') || this.reg.name(below) === 'cactus';
    }
    if (name === 'bamboo' || name === 'bamboo_sapling') return sup('supports_bamboo');
    if (name === 'lily_pad') return this.reg.name(below) === 'water';
    if (/dead_bush|dry_grass|short_dry_grass|tall_dry_grass/.test(name)) return sup('supports_dry_vegetation');
    if (name === 'brown_mushroom' || name === 'red_mushroom') return this.solid(below);
    if (name === 'cocoa') return true;
    return this.solid(below);
  }

  // ------------------------------------------------------------------ placement
  placed(id: any): any { return typeof id === 'string' ? this.worldgen['placed_feature/' + id.replace('minecraft:', '')] : id; }
  configured(id: any): any { return typeof id === 'string' ? this.worldgen['feature/' + id.replace('minecraft:', '')] : id; }

  /** PlacedFeature.place: run placement modifiers to produce positions, then the feature at each. */
  placeFeature(pf: any, g: GenAccess, r: RandomSource, ox: number, oy: number, oz: number, featureName: string, decoratingBiomes: boolean): void {
    const before = this.positions;
    this.positions = [[ox, oy, oz]];
    const positions = this.applyModifiers(pf.placement ?? [], g, r, featureName, decoratingBiomes);
    this.positions = before;
    if (!positions.length) return;
    const cf = this.configured(pf.feature);
    for (const p of positions) this.place(cf, g, r, p[0], p[1], p[2]);
  }
  private positions: [number, number, number][] = [];

  private applyModifiers(mods: any[], g: GenAccess, r: RandomSource, featureName: string, decoratingBiomes: boolean): [number, number, number][] {
    let positions = this.positions;
    for (const m of mods) {
      const t = String(m.type).replace('minecraft:', '');
      const next: [number, number, number][] = [];
      for (const p of positions) {
        switch (t) {
          case 'count': { const n = sampleInt(m.count, r); for (let i = 0; i < n; i++) next.push([p[0], p[1], p[2]]); break; }
          case 'in_square': next.push([p[0] + r.nextInt(16), p[1], p[2] + r.nextInt(16)]); break;
          case 'height_range': next.push([p[0], this.sampleHeight(m.height, r, g), p[2]]); break;
          case 'heightmap': { const h = g.height(m.heightmap, p[0], p[2]); if (h > g.minY) next.push([p[0], h, p[2]]); break; }
          case 'biome': if (!decoratingBiomes || this.biomeFeatures(g.biome(p[0], p[1], p[2])).has(featureName)) next.push(p); break;
          case 'rarity_filter': if (r.nextFloat() < 1 / m.chance) next.push(p); break;
          case 'offset': next.push([p[0] + sampleInt(m.x ?? 0, r), p[1] + sampleInt(m.y ?? 0, r), p[2] + sampleInt(m.z ?? 0, r)]); break;
          case 'random_offset': next.push([p[0] + sampleInt(m.xz_spread, r), p[1] + sampleInt(m.y_spread, r), p[2] + sampleInt(m.xz_spread, r)]); break;
          case 'block_predicate_filter': if (this.predicate(m.predicate)(g, p[0], p[1], p[2])) next.push(p); break;
          case 'surface_water_depth_filter': {
            const ocean = g.height('OCEAN_FLOOR_WG', p[0], p[2]), ws = g.height('WORLD_SURFACE_WG', p[0], p[2]);
            if (ws - ocean <= m.max_water_depth) next.push(p);
            break;
          }
          case 'surface_relative_threshold_filter': {
            const h = g.height(m.heightmap, p[0], p[2]);
            const lo = h + (m.min_inclusive ?? -2147483648), hi = h + (m.max_inclusive ?? 2147483647);
            if (p[1] >= lo && p[1] <= hi) next.push(p);
            break;
          }
          case 'noise_threshold_count': case 'noise_based_count': {
            let v: number;
            if (!this.noiseCache.has('biome_info')) this.noiseCache.set('biome_info', null);
            v = biomeInfoNoise(p[0] / 200, p[2] / 200);
            const n = t === 'noise_threshold_count' ? (v < m.noise_level ? m.below_noise : m.above_noise)
              : Math.ceil((biomeInfoNoise(p[0] / m.noise_factor, p[2] / m.noise_factor) + (m.noise_offset ?? 0)) * m.noise_to_count_ratio);
            for (let i = 0; i < n; i++) next.push([p[0], p[1], p[2]]);
            break;
          }
          case 'environment_scan': {
            const dir = m.direction_of_search === 'up' ? 1 : -1; const tgt = this.predicate(m.target_condition);
            const allowed = m.allowed_search_condition ? this.predicate(m.allowed_search_condition) : null;
            let y = p[1]; let found = false;
            for (let i = 0; i < m.max_steps; i++) {
              if (tgt(g, p[0], y, p[2])) { found = true; break; }
              y += dir;
              if (y < g.minY || y >= g.maxY) break;
              if (allowed && !allowed(g, p[0], y, p[2])) break;
            }
            if (!found && tgt(g, p[0], y, p[2])) found = true;
            if (found) next.push([p[0], y, p[2]]);
            break;
          }
          case 'count_on_every_layer': {
            const n0 = sampleInt(m.count, r);
            for (let layer = 0; layer < 16; layer++) {
              let any = false;
              for (let i = 0; i < n0; i++) {
                const x = p[0] + r.nextInt(16), z = p[2] + r.nextInt(16);
                const y = this.findOnLayer(g, x, z, layer);
                if (y !== null) { next.push([x, y, z]); any = true; }
              }
              if (!any) break;
            }
            break;
          }
          case 'fixed_placement': for (const pos of m.positions) next.push(pos); break;
          case 'random_chance': if (r.nextFloat() < m.chance) next.push(p); break;
          case 'randomly_selected': {
            const sub = m.placements[r.nextInt(m.placements.length)];
            const saved = this.positions; this.positions = [p];
            const res = this.applyModifiers([sub], g, r, featureName, decoratingBiomes);
            this.positions = saved; next.push(...res);
            break;
          }
          case 'cuboid': {
            const sx = sampleInt(m.xz_size, r), sy = sampleInt(m.y_size, r), sz = sx;
            const hx = sx >> 1, hy = sy >> 1, hz = sz >> 1;
            for (let dx = -hx; dx <= sx - 1 - hx; dx++) for (let dy = -hy; dy <= sy - 1 - hy; dy++) for (let dz = -hz; dz <= sz - 1 - hz; dz++) {
              const onX = dx === -hx || dx === sx - 1 - hx, onY = dy === -hy || dy === sy - 1 - hy, onZ = dz === -hz || dz === sz - 1 - hz;
              const planes = (onX ? 1 : 0) + (onY ? 1 : 0) + (onZ ? 1 : 0);
              if (planes === 0 && !m.include_interior) continue;
              if (planes >= 2 && !m.include_edges) continue;
              next.push([p[0] + dx, p[1] + dy, p[2] + dz]);
            }
            break;
          }
          default: throw new Error('unsupported placement modifier ' + t);
        }
      }
      positions = next;
      if (!positions.length) return positions;
    }
    return positions;
  }

  private findOnLayer(g: GenAccess, x: number, z: number, layer: number): number | null {
    let y = g.height('MOTION_BLOCKING', x, z); let n = 0;
    for (; y >= g.minY + 1; y--) {
      const here = g.get(x, y, z), below = g.get(x, y - 1, z);
      if ((here === 0 || this.reg.name(here) === 'water' || this.isAir(here)) && this.solid(below) && this.reg.name(below) !== 'bedrock') {
        if (n === layer) return y;
        n++;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ features
  place(cf0: any, g: GenAccess, r: RandomSource, x: number, y: number, z: number): boolean {
    const cf = this.configured(cf0);
    if (!cf) return false;
    if (cf.feature !== undefined && cf.type === undefined) { this.placeFeature(cf, g, r, x, y, z, '', false); return true; }
    const t = String(cf.type).replace('minecraft:', '');
    const c = cf.config ?? cf;
    this.stats.set(t, (this.stats.get(t) ?? 0) + 1);
    switch (t) {
      case 'simple_block': {
        const s = this.provider(c.to_place)(r, x, y, z, g);
        if (s < 0 || !this.canSurvive(s, g, x, y, z)) return false;
        const half = this.reg.prop(s, 'half');
        if (half === 'lower') {
          if (!this.isAir(g.get(x, y + 1, z))) return false;
          g.set(x, y, z, s); g.set(x, y + 1, z, this.reg.withProp(s, 'half', 'upper'));
        } else g.set(x, y, z, s);
        return true;
      }
      case 'random_selector': {
        for (const e of c.features) if (r.nextFloat() < e.chance) { this.placeFeature(this.placed(e.feature) ?? { feature: e.feature, placement: [] }, g, r, x, y, z, '', false); return true; }
        this.placeFeature(this.placed(c.default) ?? { feature: c.default, placement: [] }, g, r, x, y, z, '', false);
        return true;
      }
      case 'simple_random_selector': { const fs = c.features; const f = fs[r.nextInt(fs.length)]; this.placeFeature(this.placed(f) ?? { feature: f, placement: [] }, g, r, x, y, z, '', false); return true; }
      case 'weighted_random_selector': {
        const ents = c.features ?? c.distribution; let total = 0; for (const e of ents) total += e.weight;
        let p = r.nextInt(total);
        for (const e of ents) { p -= e.weight; if (p < 0) { const f = e.data ?? e.feature; this.placeFeature(this.placed(f) ?? { feature: f, placement: [] }, g, r, x, y, z, '', false); break; } }
        return true;
      }
      case 'random_boolean_selector': {
        const f = r.nextBoolean() ? c.feature_true : c.feature_false;
        this.placeFeature(this.placed(f) ?? { feature: f, placement: [] }, g, r, x, y, z, '', false); return true;
      }
      case 'sequence': for (const f of c.features) this.placeFeature(this.placed(f) ?? { feature: f, placement: [] }, g, r, x, y, z, '', false); return true;
      case 'ore': case 'scattered_ore': return this.ore(c, g, r, x, y, z, t === 'scattered_ore');
      case 'tree': return this.tree(c, g, r, x, y, z);
      case 'block_column': return this.blockColumn(c, g, r, x, y, z);
      case 'disk': return this.disk(c, g, r, x, y, z);
      case 'spring_feature': return this.spring(c, g, x, y, z);
      case 'lake': return this.lake(c, g, r, x, y, z);
      case 'monster_room': return this.monsterRoom(g, r, x, y, z);
      case 'freeze_top_layer': return this.freeze(g, x, z);
      case 'fallen_tree': return this.fallenTree(c, g, r, x, y, z);
      case 'huge_brown_mushroom': case 'huge_red_mushroom': return this.hugeMushroom(c, g, r, x, y, z, t === 'huge_red_mushroom');
      case 'block_pile': return this.blockPile(c, g, r, x, y, z);
      case 'bamboo': return this.bamboo(c, g, r, x, y, z);
      case 'vines': return this.vines(g, x, y, z);
      case 'multiface_growth': return this.multiface(c, g, r, x, y, z);
      case 'blue_ice': case 'underwater_magma': case 'vegetation_patch': case 'waterlogged_vegetation_patch':
      case 'geode': case 'fossil': case 'large_dripstone': case 'speleothem_cluster': case 'root_system': case 'iceberg':
      case 'block_blob': case 'random_neighbor_spread': case 'spike': case 'overlay': case 'bonus_chest':
        if (t === 'vegetation_patch' || t === 'waterlogged_vegetation_patch') return this.vegetationPatch(c, g, r, x, y, z, t === 'waterlogged_vegetation_patch');
        if (t === 'block_blob') return this.blockBlob(c, g, r, x, y, z);
        return false; // listed in DEVIATIONS.md
      default: return false;
    }
  }

  private targetsMatch(target: any, g: GenAccess, s: number, y: number): boolean {
    const pt = String(target.predicate_type).replace('minecraft:', '');
    switch (pt) {
      case 'always_true': return true;
      case 'tag_match': return this.tags.has(target.tag, s);
      case 'block_match': return this.reg.name(s) === target.block.replace('minecraft:', '');
      case 'blockstate_match': return s === this.stateOf(target.block_state);
      case 'random_block_match': return this.reg.name(s) === target.block.replace('minecraft:', '') && Math.random() < 0; // probability handled below
      case 'height_match': return y >= target.min_inclusive && y <= target.max_inclusive;
      case 'all_of': return target.rules.every((rl: any) => this.targetsMatch(rl, g, s, y));
      case 'any_of': return target.rules.some((rl: any) => this.targetsMatch(rl, g, s, y));
      case 'not': return !this.targetsMatch(target.rule, g, s, y);
      default: return false;
    }
  }

  /** OreFeature: ellipsoid blob along a random line; ScatteredOreFeature: random points. */
  private ore(c: any, g: GenAccess, r: RandomSource, x: number, y: number, z: number, scattered: boolean): boolean {
    const targets = c.targets.map((t: any) => ({ t: t.target, s: this.stateOf(t.state) }));
    const discard = c.discard_chance_on_air_exposure ?? 0;
    const tryPlace = (px: number, py: number, pz: number) => {
      if (py < g.minY || py >= g.maxY) return;
      const cur = g.get(px, py, pz);
      for (const t of targets) if (this.targetsMatch(t.t, g, cur, py)) {
        if (discard > 0 && this.exposed(g, px, py, pz) && r.nextFloat() < discard) return;
        g.set(px, py, pz, t.s); return;
      }
    };
    if (scattered) {
      const n = r.nextInt(c.size + 1);
      for (let i = 0; i < n; i++) {
        const d = Math.min(i, 7);
        tryPlace(x + Math.round((r.nextFloat() - r.nextFloat()) * d), y + Math.round((r.nextFloat() - r.nextFloat()) * d), z + Math.round((r.nextFloat() - r.nextFloat()) * d));
      }
      return true;
    }
    const f = r.nextFloat() * Math.PI;
    const g8 = c.size / 8;
    const sz = c.size;
    const d = x + Math.sin(f) * g8, e = x - Math.sin(f) * g8, h = z + Math.cos(f) * g8, k = z - Math.cos(f) * g8;
    const l = y + r.nextInt(3) - 2, m = y + r.nextInt(3) - 2;
    for (let i = 0; i < sz; i++) {
      const t = i / sz;
      const cx = d + (e - d) * t, cy = l + (m - l) * t, cz = h + (k - h) * t;
      const rr = (r.nextDouble() * sz) / 16;
      const rad = ((Math.sin(Math.PI * t) + 1) * rr + 1) / 2;
      for (let bx = Math.floor(cx - rad); bx <= Math.floor(cx + rad); bx++)
        for (let by = Math.floor(cy - rad); by <= Math.floor(cy + rad); by++)
          for (let bz = Math.floor(cz - rad); bz <= Math.floor(cz + rad); bz++) {
            const dx = (bx + 0.5 - cx) / rad, dy = (by + 0.5 - cy) / rad, dz = (bz + 0.5 - cz) / rad;
            if (dx * dx + dy * dy + dz * dz < 1) tryPlace(bx, by, bz);
          }
    }
    return true;
  }
  private exposed(g: GenAccess, x: number, y: number, z: number): boolean {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (this.isAir(g.get(x + dx, y + dy, z + dz))) return true;
    return false;
  }

  // ------------------------------------------------------------------ trees
  private tree(c: any, g: GenAccess, r: RandomSource, x: number, y: number, z: number): boolean {
    const trunkP = this.provider(c.trunk_provider), folP = this.provider(c.foliage_provider);
    const below = c.below_trunk_provider ? this.provider(c.below_trunk_provider) : null;
    const tp = c.trunk_placer; const fp = c.foliage_placer;
    const ttype = String(tp.type).replace('minecraft:', ''), ftype = String(fp.type).replace('minecraft:', '');
    const height = tp.base_height + r.nextInt(tp.height_rand_a + 1) + r.nextInt(tp.height_rand_b + 1);
    if (y < g.minY + 1 || y + height + 1 > g.maxY) return false;
    // space check (TreeFeature.getMaxFreeTreeHeight, simplified to the trunk column)
    for (let i = 0; i <= height; i++) {
      const s = g.get(x, y + i, z);
      if (!(this.isAir(s) || this.tags.has('replaceable_by_trees', s) || this.tags.has('leaves', s))) { if (i < (c.minimum_size?.min_clipped_height ?? height)) return false; }
    }
    const logs: [number, number, number][] = [];
    const setLog = (px: number, py: number, pz: number, axis = 'y') => {
      const cur = g.get(px, py, pz);
      if (!(this.isAir(cur) || this.tags.has('replaceable_by_trees', cur) || this.tags.has('leaves', cur) || this.reg.name(cur) === 'water')) return;
      let s = trunkP(r, px, py, pz, g);
      if (this.reg.hasProp(s, 'axis')) s = this.reg.withProp(s, 'axis', axis);
      g.set(px, py, pz, s); logs.push([px, py, pz]);
    };
    const leaves: [number, number, number][] = [];
    const setLeaf = (px: number, py: number, pz: number) => {
      const cur = g.get(px, py, pz);
      if (!(this.isAir(cur) || this.tags.has('replaceable_by_trees', cur))) return;
      let s = folP(r, px, py, pz, g);
      if (this.reg.name(cur) === 'water' && this.reg.hasProp(s, 'waterlogged')) s = this.reg.withProp(s, 'waterlogged', 'true');
      g.set(px, py, pz, s); leaves.push([px, py, pz]);
    };
    const dirtBelow = (px: number, py: number, pz: number) => { if (below) { const s = below(r, px, py, pz, g); if (s >= 0) g.set(px, py, pz, s); } };
    // foliage attachment points: [x, y, z, radiusOffset, doubleTrunk]
    const att: [number, number, number, number, boolean][] = [];
    switch (ttype) {
      case 'straight_trunk_placer': case 'poplar_trunk_placer':
        dirtBelow(x, y - 1, z);
        for (let i = 0; i < height; i++) setLog(x, y + i, z);
        att.push([x, y + height, z, 0, false]);
        break;
      case 'forking_trunk_placer': {
        dirtBelow(x, y - 1, z);
        const dir = [[1, 0], [-1, 0], [0, 1], [0, -1]][r.nextInt(4)];
        const i = height - r.nextInt(4) - 1; let j = 3 - r.nextInt(3);
        let px = x, pz = z, top = y + height;
        for (let k = 0; k < height; k++) {
          const ly = y + k;
          if (k >= i && j > 0) { px += dir[0]; pz += dir[1]; j--; }
          setLog(px, ly, pz); top = ly + 1;
        }
        att.push([px, top, pz, 1, false]);
        const dir2 = [[1, 0], [-1, 0], [0, 1], [0, -1]][r.nextInt(4)];
        if (dir2[0] !== dir[0] || dir2[1] !== dir[1]) {
          const k2 = i - r.nextInt(2) - 1; let l2 = 1 + r.nextInt(3);
          px = x; pz = z; let ly = 0;
          for (let m = k2; m < height && l2 > 0; m++, l2--) { if (m >= 1) { ly = y + m; px += dir2[0]; pz += dir2[1]; setLog(px, ly, pz); } }
          if (ly > 0) att.push([px, ly + 1, pz, 0, false]);
        }
        break;
      }
      case 'giant_trunk_placer': case 'dark_oak_trunk_placer': case 'mega_jungle_trunk_placer':
        for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) dirtBelow(x + dx, y - 1, z + dz);
        for (let i = 0; i < height; i++) for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) setLog(x + dx, y + i, z + dz);
        att.push([x, y + height, z, 0, true]);
        break;
      case 'fancy_trunk_placer': {
        dirtBelow(x, y - 1, z);
        const h = height + 2;
        const trunkH = Math.floor(h * 0.618);
        for (let i = 0; i < trunkH; i++) setLog(x, y + i, z);
        const clusters = Math.max(1, Math.floor(1.382 + Math.pow((h) / 13, 2)));
        att.push([x, y + trunkH, z, 0, false]);
        for (let l = h - 5; l >= 0; l--) {
          const shape = treeShape(h, l);
          if (shape < 0) continue;
          for (let k = 0; k < clusters; k++) {
            const rad = shape * (r.nextFloat() + 0.328);
            const ang = r.nextFloat() * 2 * Math.PI;
            const bx = Math.floor(rad * Math.sin(ang) + x + 0.5), bz = Math.floor(rad * Math.cos(ang) + z + 0.5), by = y + l - 1;
            const by2 = Math.min(by + 4, y + trunkH - 1);
            // branch log line
            const steps = Math.max(Math.abs(bx - x), Math.abs(by - by2), Math.abs(bz - z));
            for (let s = 1; s <= steps; s++) {
              const fx = Math.floor(x + 0.5 + ((bx - x) * s) / steps), fy = Math.floor(by2 + 0.5 + ((by - by2) * s) / steps), fz = Math.floor(z + 0.5 + ((bz - z) * s) / steps);
              const axis = Math.abs(bx - x) >= Math.abs(bz - z) && Math.abs(bx - x) > Math.abs(by - by2) ? 'x' : Math.abs(bz - z) > Math.abs(by - by2) ? 'z' : 'y';
              setLog(fx, fy, fz, axis);
            }
            att.push([bx, by, bz, 0, false]);
          }
        }
        break;
      }
      case 'bending_trunk_placer': case 'upwards_branching_trunk_placer': case 'cherry_trunk_placer': default: {
        dirtBelow(x, y - 1, z);
        let px = x, pz = z;
        for (let i = 0; i < height; i++) {
          if (ttype === 'bending_trunk_placer' && i >= (tp.min_height_for_leaves ?? 1) && r.nextInt(3) === 0) { const d = [[1, 0], [-1, 0], [0, 1], [0, -1]][r.nextInt(4)]; px += d[0]; pz += d[1]; }
          setLog(px, y + i, pz);
        }
        att.push([px, y + height, pz, 0, false]);
        if (ttype === 'cherry_trunk_placer') {
          const d = [[1, 0], [-1, 0], [0, 1], [0, -1]][r.nextInt(4)];
          const bx = x + d[0] * 3, bz = z + d[1] * 3, by = y + height - 2;
          for (let s = 1; s <= 3; s++) setLog(x + d[0] * s, by, z + d[1] * s, d[0] ? 'x' : 'z');
          setLog(bx, by + 1, bz);
          att.push([bx, by + 2, bz, 0, false]);
        }
      }
    }
    // foliage
    const fh = typeof fp.height === 'number' ? fp.height : fp.height ? sampleInt(fp.height, r) : 3;
    const radius = sampleInt(fp.radius ?? 2, r), offset = sampleInt(fp.offset ?? 0, r);
    for (const [ax, ay, az, rOff, dbl] of att) {
      const R = radius + rOff;
      const dd = dbl ? 1 : 0;
      const ring = (ly: number, rr: number, skip: (dx: number, dz: number, rr: number) => boolean) => {
        for (let dx = -rr; dx <= rr + dd; dx++) for (let dz = -rr; dz <= rr + dd; dz++) {
          const ex = dbl && dx > 0 ? dx - 1 : dx, ez = dbl && dz > 0 ? dz - 1 : dz;
          if (!skip(Math.abs(ex), Math.abs(ez), rr)) setLeaf(ax + dx, ly, az + dz);
        }
      };
      switch (ftype) {
        case 'blob_foliage_placer':
          // BlobFoliagePlacer: radius + offset - 1 - j/2 (Java integer division), corners skipped randomly or on the top row
          for (let j = offset; j >= offset - fh; j--) {
            const k = Math.max(R - 1 - Math.trunc(j / 2), 0);
            ring(ay + j, k, (dx, dz, q) => dx === q && dz === q && (r.nextInt(2) === 0 || j === 0));
          }
          break;
        case 'bush_foliage_placer':
          for (let j = offset; j >= offset - fh; j--) ring(ay + j, Math.max(R - 1 - j, 0), (dx, dz, q) => dx === q && dz === q && r.nextInt(2) === 0);
          break;
        case 'fancy_foliage_placer':
          for (let j = offset; j >= offset - fh; j--) {
            const k = R + (j !== offset && j !== offset - fh ? 1 : 0);
            ring(ay + j, k, (dx, dz, q) => (dx + 0.5) * (dx + 0.5) + (dz + 0.5) * (dz + 0.5) > q * q);
          }
          break;
        case 'spruce_foliage_placer': {
          const th = sampleInt(fp.trunk_height ?? 1, r);
          const total = height - th;
          let rr = r.nextInt(2), max = 1, start = 0;
          for (let ly = offset; ly >= -total; ly--) {
            ring(ay + ly, rr, (dx, dz, q) => dx === q && dz === q && q > 0);
            if (rr >= max) { rr = start; start = 1; max = Math.min(max + 1, R); } else rr++;
          }
          break;
        }
        case 'pine_foliage_placer': case 'mega_pine_foliage_placer': {
          let rr = 0;
          const total = ftype === 'pine_foliage_placer' ? sampleInt(fp.height ?? 3, r) : sampleInt(fp.crown_height ?? 13, r);
          for (let ly = offset; ly >= offset - total; ly--) {
            ring(ay + ly, rr, (dx, dz, q) => dx === q && dz === q && q > 0);
            if (rr >= 1 && ly === offset - total + 1) rr--; else if (rr < R) rr++;
          }
          break;
        }
        case 'acacia_foliage_placer': {
          const corner0 = (dx: number, dz: number, q: number) => dx === q && dz === q && q > 0;
          ring(ay - 1, R, corner0);
          ring(ay, R - 1, (dx, dz) => (dx > 1 || dz > 1) && dx !== 0 && dz !== 0);
          ring(ay, R - 1, (dx, dz) => (dx > 1 || dz > 1) && dx !== 0 && dz !== 0);
          break;
        }
        case 'dark_oak_foliage_placer': {
          const b0 = ay + offset;
          const skip = (dx: number, dz: number, q: number) => dx === q && dz === q && r.nextInt(2) === 0;
          if (dbl) { ring(b0 - 1, R + 2, skip); ring(b0, R + 3, (dx, dz, q) => dx >= q - 1 && dz >= q - 1); ring(b0 + 1, R + 2, skip); if (r.nextBoolean()) ring(b0 + 2, R, skip); }
          else { ring(b0 - 1, R + 2, skip); ring(b0, R + 1, skip); }
          break;
        }
        case 'jungle_foliage_placer':
          for (let ly = offset; ly >= offset - fh; ly--) ring(ay + ly, R + (offset - ly), (dx, dz, q) => dx * dx + dz * dz > q * q);
          break;
        case 'random_spread_foliage_placer': case 'cherry_foliage_placer': case 'poplar_foliage_placer': default: {
          const fhh = typeof fp.foliage_height === 'number' ? fp.foliage_height : fp.foliage_height ? sampleInt(fp.foliage_height, r) : fh;
          const attempts = fp.leaf_placement_attempts ?? 0;
          if (attempts) {
            for (let i = 0; i < attempts; i++) setLeaf(ax + r.nextInt(R) - r.nextInt(R), ay + r.nextInt(fhh) - r.nextInt(fhh), az + r.nextInt(R) - r.nextInt(R));
          } else {
            for (let ly = 0; ly <= fhh; ly++) ring(ay - ly + offset, Math.max(1, R - (ly === 0 ? 1 : 0)), (dx, dz, q) => dx === q && dz === q && r.nextInt(3) === 0);
          }
        }
      }
    }
    // leaf distance property (LeavesBlock distance to nearest log, max 7)
    this.updateLeafDistance(g, leaves, logs);
    for (const d of c.decorators ?? []) this.decorate(d, g, r, logs, leaves);
    return logs.length > 0;
  }

  private updateLeafDistance(g: GenAccess, leaves: [number, number, number][], logs: [number, number, number][]): void {
    const dist = new Map<string, number>();
    const k = (x: number, y: number, z: number) => x + ',' + y + ',' + z;
    const leafSet = new Set(leaves.map((p) => k(...p)));
    let frontier = logs.map((p) => [...p, 0] as number[]);
    while (frontier.length) {
      const next: number[][] = [];
      for (const [x, y, z, d] of frontier) for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const key = k(x + dx, y + dy, z + dz);
        if (!leafSet.has(key) || dist.has(key) || d + 1 > 7) continue;
        dist.set(key, d + 1); next.push([x + dx, y + dy, z + dz, d + 1]);
      }
      frontier = next;
    }
    for (const [x, y, z] of leaves) {
      const s = g.get(x, y, z);
      if (this.reg.hasProp(s, 'distance')) g.set(x, y, z, this.reg.withProp(s, 'distance', String(dist.get(k(x, y, z)) ?? 7)));
    }
  }

  private decorate(d: any, g: GenAccess, r: RandomSource, logs: [number, number, number][], leaves: [number, number, number][]): void {
    const t = String(d.type).replace('minecraft:', '');
    switch (t) {
      case 'beehive': {
        if (r.nextFloat() >= d.probability || !logs.length) return;
        const base = logs.reduce((a, b) => (b[1] < a[1] ? b : a));
        const y = base[1] + 1 + Math.min(2, Math.max(0, logs.length > 3 ? 1 : 0));
        const dir = ['south', 'east', 'west'][r.nextInt(3)] ?? 'south';
        const off = { south: [0, 1], east: [1, 0], west: [-1, 0] }[dir as 'south'];
        const px = base[0] + off[0], pz = base[2] + off[1];
        if (this.isAir(g.get(px, y, pz))) g.set(px, y, pz, this.reg.state('bee_nest', { facing: dir }));
        return;
      }
      case 'trunk_vine': for (const [x, y, z] of logs) for (const [dx, dz, face] of [[-1, 0, 'east'], [1, 0, 'west'], [0, -1, 'south'], [0, 1, 'north']] as [number, number, string][]) {
        if (r.nextInt(3) > 0 && this.isAir(g.get(x + dx, y, z + dz))) g.set(x + dx, y, z + dz, this.reg.state('vine', { [face]: 'true' }));
      } return;
      case 'leave_vine': for (const [x, y, z] of leaves) for (const [dx, dz, face] of [[-1, 0, 'east'], [1, 0, 'west'], [0, -1, 'south'], [0, 1, 'north']] as [number, number, string][]) {
        if (r.nextFloat() < d.probability && this.isAir(g.get(x + dx, y, z + dz))) {
          const s = this.reg.state('vine', { [face]: 'true' });
          for (let i = 0; i < 4 && this.isAir(g.get(x + dx, y - i, z + dz)); i++) g.set(x + dx, y - i, z + dz, s);
        }
      } return;
      case 'cocoa': if (r.nextFloat() >= d.probability) return;
        for (const [x, y, z] of logs) if (r.nextInt(4) === 0) for (const [dx, dz, face] of [[-1, 0, 'east'], [1, 0, 'west'], [0, -1, 'south'], [0, 1, 'north']] as [number, number, string][]) {
          if (r.nextFloat() <= 0.25 && this.isAir(g.get(x + dx, y, z + dz))) g.set(x + dx, y, z + dz, this.reg.state('cocoa', { facing: face, age: String(r.nextInt(3)) }));
        } return;
      case 'alter_ground': {
        const p = this.provider(d.provider);
        if (!logs.length) return;
        const minY = Math.min(...logs.map((l) => l[1]));
        for (const [x, , z] of logs.filter((l) => l[1] === minY)) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
          if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
          for (let dy = 2; dy >= -3; dy--) { const s = g.get(x + dx, minY + dy - 1, z + dz); if (this.tags.has('dirt', s)) { const ns = p(r, x + dx, minY + dy - 1, z + dz, g); if (ns >= 0) g.set(x + dx, minY + dy - 1, z + dz, ns); break; } }
        }
        return;
      }
      case 'place_on_ground': {
        const p = this.provider(d.block_state_provider); const tries = d.tries ?? 128;
        if (!logs.length) return;
        const base = logs.reduce((a, b) => (b[1] < a[1] ? b : a));
        for (let i = 0; i < tries; i++) {
          const x = base[0] + r.nextInt(7) - r.nextInt(7), z = base[2] + r.nextInt(7) - r.nextInt(7), y = base[1] + r.nextInt(2) - r.nextInt(2);
          if (this.isAir(g.get(x, y, z)) && this.solid(g.get(x, y - 1, z))) { const s = p(r, x, y, z, g); if (s >= 0) g.set(x, y, z, s); }
        }
        return;
      }
      case 'attached_to_leaves': {
        const p = this.provider(d.block_provider);
        for (const [x, y, z] of leaves) if (r.nextFloat() < d.probability && this.isAir(g.get(x, y - 1, z))) { const s = p(r, x, y - 1, z, g); if (s >= 0) g.set(x, y - 1, z, s); }
        return;
      }
      default: return; // pale_moss, creaking_heart, shelf_mushroom: DEVIATIONS.md
    }
  }

  // ------------------------------------------------------------------ misc features
  private blockColumn(c: any, g: GenAccess, r: RandomSource, x: number, y: number, z: number): boolean {
    const dir = { up: 1, down: -1 }[c.direction as 'up'] ?? 1;
    const allowed = c.allowed_placement ? this.predicate(c.allowed_placement) : () => true;
    const layers = c.layers.map((l: any) => ({ h: sampleInt(l.height, r), p: this.provider(l.provider) }));
    let total = 0; for (const l of layers) total += l.h;
    let yy = y;
    let free = 0;
    for (; free < total; free++) if (!allowed(g, x, y + free * dir, z)) break;
    if (free < total && !c.prioritize_tip) total = free;
    for (const l of layers) for (let i = 0; i < l.h && total > 0; i++, total--) {
      const s = l.p(r, x, yy, z, g);
      if (s >= 0) g.set(x, yy, z, s);
      yy += dir;
    }
    return true;
  }
  private disk(c: any, g: GenAccess, r: RandomSource, x: number, y: number, z: number): boolean {
    const target = this.predicate(c.target); const st = this.provider(c.state_provider);
    const rad = sampleInt(c.radius, r); const hh = c.half_height;
    for (let dx = -rad; dx <= rad; dx++) for (let dz = -rad; dz <= rad; dz++) {
      if (dx * dx + dz * dz > rad * rad) continue;
      for (let dy = y + hh; dy >= y - hh; dy--) if (target(g, x + dx, dy, z + dz)) { const s = st(r, x + dx, dy, z + dz, g); if (s >= 0) g.set(x + dx, dy, z + dz, s); }
    }
    return true;
  }
  private spring(c: any, g: GenAccess, x: number, y: number, z: number): boolean {
    const valid = new Set((Array.isArray(c.valid_blocks) ? c.valid_blocks : [c.valid_blocks]).map((b: string) => b.replace('minecraft:', '')));
    const ok = (s: number) => valid.has(this.reg.name(s));
    if (!ok(g.get(x, y + 1, z))) return false;
    if (c.requires_block_below && !ok(g.get(x, y - 1, z))) return false;
    if (!this.isAir(g.get(x, y, z)) && !ok(g.get(x, y, z))) return false;
    let rock = 0, hole = 0;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
      const s = g.get(x + dx, y + dy, z + dz);
      if (ok(s)) rock++; else if (this.isAir(s)) hole++;
    }
    if (rock === c.rock_count && hole === c.hole_count) {
      const fl = c.state?.Name ?? c.state?.id ?? 'minecraft:water';
      g.set(x, y, z, this.reg.state(fl.includes('lava') ? 'lava' : 'water', { level: '0' }));
      return true;
    }
    return false;
  }
  private lake(c: any, g: GenAccess, r: RandomSource, x: number, y: number, z: number): boolean {
    if (y <= g.minY + 4) return false;
    y -= 4;
    const fluid = this.provider(c.fluid)(r, x, y, z, g), barrier = this.provider(c.barrier);
    const mask = new Uint8Array(2048);
    const n = r.nextInt(4) + 4;
    for (let i = 0; i < n; i++) {
      const d = r.nextDouble() * 6 + 3, e = r.nextDouble() * 4 + 2, f = r.nextDouble() * 6 + 3;
      const gg = r.nextDouble() * (16 - d - 2) + 1 + d / 2, h = r.nextDouble() * (8 - e - 4) + 2 + e / 2, k = r.nextDouble() * (16 - f - 2) + 1 + f / 2;
      for (let l = 1; l < 15; l++) for (let m = 1; m < 15; m++) for (let o = 1; o < 7; o++) {
        const p = (l - gg) / (d / 2), q = (o - h) / (e / 2), s = (m - k) / (f / 2);
        if (p * p + q * q + s * s < 1) mask[(l * 16 + m) * 8 + o] = 1;
      }
    }
    const at = (l: number, m: number, o: number) => mask[(l * 16 + m) * 8 + o];
    for (let l = 0; l < 16; l++) for (let m = 0; m < 16; m++) for (let o = 0; o < 8; o++) {
      const edge = !at(l, m, o) && ((l < 15 && at(l + 1, m, o)) || (l > 0 && at(l - 1, m, o)) || (m < 15 && at(l, m + 1, o)) || (m > 0 && at(l, m - 1, o)) || (o < 7 && at(l, m, o + 1)) || (o > 0 && at(l, m, o - 1)));
      if (!edge) continue;
      const s = g.get(x + l - 8, y + o, z + m - 8);
      if (o >= 4 && this.reg.name(s) === 'water' || this.reg.name(s) === 'lava') return false;
      if (o < 4 && !this.solid(s) && s !== fluid) return false;
    }
    for (let l = 0; l < 16; l++) for (let m = 0; m < 16; m++) for (let o = 0; o < 8; o++) {
      if (!at(l, m, o)) continue;
      const px = x + l - 8, py = y + o, pz = z + m - 8;
      if (this.tags.has('features_cannot_replace', g.get(px, py, pz))) continue;
      g.set(px, py, pz, o >= 4 ? 0 : fluid);
    }
    const isLava = this.reg.name(fluid) === 'lava';
    if (isLava) for (let l = 0; l < 16; l++) for (let m = 0; m < 16; m++) for (let o = 0; o < 8; o++) {
      const edge = !at(l, m, o) && ((l < 15 && at(l + 1, m, o)) || (l > 0 && at(l - 1, m, o)) || (m < 15 && at(l, m + 1, o)) || (m > 0 && at(l, m - 1, o)) || (o < 7 && at(l, m, o + 1)) || (o > 0 && at(l, m, o - 1)));
      if (edge && (o < 4 || r.nextInt(2) !== 0)) {
        const px = x + l - 8, py = y + o, pz = z + m - 8;
        if (this.solid(g.get(px, py, pz)) && !this.tags.has('lava_pool_stone_cannot_replace', g.get(px, py, pz))) { const b = barrier(r, px, py, pz, g); if (b >= 0) g.set(px, py, pz, b); }
      }
    }
    return true;
  }
  private monsterRoom(g: GenAccess, r: RandomSource, x: number, y: number, z: number): boolean {
    const j = r.nextInt(2) + 2, m = r.nextInt(2) + 2;
    let openings = 0;
    for (let dx = -j - 1; dx <= j + 1; dx++) for (let dy = -1; dy <= 4; dy++) for (let dz = -m - 1; dz <= m + 1; dz++) {
      const s = g.get(x + dx, y + dy, z + dz); const sol = this.solid(s);
      if (dy === -1 && !sol) return false;
      if (dy === 4 && !sol) return false;
      if ((dx === -j - 1 || dx === j + 1 || dz === -m - 1 || dz === m + 1) && dy === 0 && this.isAir(s) && this.isAir(g.get(x + dx, y + 1, z + dz))) openings++;
    }
    if (openings < 1 || openings > 5) return false;
    const cobble = this.reg.state('cobblestone'), mossy = this.reg.state('mossy_cobblestone');
    for (let dx = -j - 1; dx <= j + 1; dx++) for (let dy = 3; dy >= -1; dy--) for (let dz = -m - 1; dz <= m + 1; dz++) {
      const px = x + dx, py = y + dy, pz = z + dz;
      const wall = dx === -j - 1 || dx === j + 1 || dy === -1 || dz === -m - 1 || dz === m + 1;
      const s = g.get(px, py, pz);
      if (!wall) { if (this.reg.name(s) !== 'chest' && this.reg.name(s) !== 'spawner') g.set(px, py, pz, 0); }
      else if (py >= g.minY && !this.solid(g.get(px, py - 1, pz))) g.set(px, py, pz, 0);
      else if (this.solid(s) && this.reg.name(s) !== 'chest') g.set(px, py, pz, dy === -1 && r.nextInt(4) !== 0 ? mossy : cobble);
    }
    for (let k = 0; k < 2; k++) for (let tries = 0; tries < 3; tries++) {
      const px = x + r.nextInt(j * 2 + 1) - j, pz = z + r.nextInt(m * 2 + 1) - m;
      if (!this.isAir(g.get(px, y, pz))) continue;
      let walls = 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (this.solid(g.get(px + dx, y, pz + dz))) walls++;
      if (walls === 1) { g.set(px, y, pz, this.reg.state('chest')); break; }
    }
    g.set(x, y, z, this.reg.state('spawner'));
    return true;
  }
  private freeze(g: GenAccess, x0: number, z0: number): boolean {
    const bx = Math.floor(x0 / 16) * 16, bz = Math.floor(z0 / 16) * 16;
    for (let dx = 0; dx < 16; dx++) for (let dz = 0; dz < 16; dz++) {
      const x = bx + dx, z = bz + dz;
      const y = g.height('MOTION_BLOCKING', x, z);
      const b = g.biome(x, y, z);
      if (!this.coldEnough(b, x, y, z)) continue;
      const below = g.get(x, y - 1, z);
      if (this.reg.name(below) === 'water' && this.reg.prop(below, 'level') === '0') g.set(x, y - 1, z, this.reg.state('ice'));
      else if (this.isAir(g.get(x, y, z)) && this.solid(below) && !this.tags.has('cannot_support_snow_layer', below)) g.set(x, y, z, this.reg.state('snow'));
    }
    return true;
  }
  coldEnough: (biome: number, x: number, y: number, z: number) => boolean = () => false;
  private fallenTree(c: any, g: GenAccess, r: RandomSource, x: number, y: number, z: number): boolean {
    const p = this.provider(c.trunk_provider);
    const len = sampleInt(c.log_length, r);
    const horiz = r.nextBoolean();
    const [dx, dz] = horiz ? [1, 0] : [0, 1];
    for (let i = 0; i < len + 2; i++) if (!this.isAir(g.get(x + dx * (i + 2), y, z + dz * (i + 2))) || !this.solid(g.get(x + dx * (i + 2), y - 1, z + dz * (i + 2)))) return false;
    g.set(x, y, z, p(r, x, y, z, g));
    for (let i = 0; i < len; i++) {
      let s = p(r, x, y, z, g);
      if (this.reg.hasProp(s, 'axis')) s = this.reg.withProp(s, 'axis', horiz ? 'x' : 'z');
      g.set(x + dx * (i + 2), y, z + dz * (i + 2), s);
    }
    return true;
  }
  private hugeMushroom(c: any, g: GenAccess, r: RandomSource, x: number, y: number, z: number, red: boolean): boolean {
    const h = r.nextInt(3) + 4 + (r.nextInt(12) === 0 ? h2(r) : 0);
    const stem = this.provider(c.stem_provider), cap = this.provider(c.cap_provider);
    for (let i = 0; i < h; i++) if (!this.isAir(g.get(x, y + i, z)) && !this.tags.has('replaceable_by_mushrooms', g.get(x, y + i, z))) return false;
    for (let i = 0; i < h; i++) g.set(x, y + i, z, stem(r, x, y + i, z, g));
    const R = c.foliage_radius ?? 2;
    if (red) {
      for (let dy = h - 3; dy <= h; dy++) {
        const rr = dy < h ? R : R - 1;
        for (let dx = -rr; dx <= rr; dx++) for (let dz = -rr; dz <= rr; dz++) {
          const ex = Math.abs(dx) === rr, ez = Math.abs(dz) === rr;
          if (dy < h && !(ex || ez)) continue;
          if (ex && ez) continue;
          if (this.isAir(g.get(x + dx, y + dy, z + dz))) g.set(x + dx, y + dy, z + dz, cap(r, x + dx, y + dy, z + dz, g));
        }
      }
    } else {
      const rr = R + 1;
      for (let dx = -rr; dx <= rr; dx++) for (let dz = -rr; dz <= rr; dz++) {
        if (Math.abs(dx) === rr && Math.abs(dz) === rr) continue;
        if (this.isAir(g.get(x + dx, y + h, z + dz))) g.set(x + dx, y + h, z + dz, cap(r, x + dx, y + h, z + dz, g));
      }
    }
    return true;
  }
  private blockPile(c: any, g: GenAccess, r: RandomSource, x: number, y: number, z: number): boolean {
    const p = this.provider(c.state_provider);
    const rx = 2 + r.nextInt(2), rz = 2 + r.nextInt(2);
    for (let dx = -rx; dx <= rx; dx++) for (let dz = -rz; dz <= rz; dz++) for (let dy = 0; dy <= 1; dy++) {
      const d = dx * dx + dz * dz;
      if (d > r.nextFloat() * 10 + r.nextFloat() * 6) continue;
      const px = x + dx, py = y + dy, pz = z + dz;
      if (this.isAir(g.get(px, py, pz)) && this.solid(g.get(px, py - 1, pz))) { const s = p(r, px, py, pz, g); if (s >= 0) g.set(px, py, pz, s); }
    }
    return true;
  }
  private bamboo(c: any, g: GenAccess, r: RandomSource, x: number, y: number, z: number): boolean {
    if (!this.isAir(g.get(x, y, z))) return false;
    const h = r.nextInt(12) + 5;
    if (r.nextFloat() < (c.probability ?? 0)) {
      const rr = r.nextInt(4) + 1;
      for (let dx = -rr; dx <= rr; dx++) for (let dz = -rr; dz <= rr; dz++) if (dx * dx + dz * dz <= rr * rr) {
        const yy = g.height('WORLD_SURFACE', x + dx, z + dz) - 1;
        if (this.tags.has('beneath_bamboo_podzol_replaceable', g.get(x + dx, yy, z + dz))) g.set(x + dx, yy, z + dz, this.reg.state('podzol'));
      }
    }
    for (let i = 0; i < h && this.isAir(g.get(x, y + i, z)); i++) {
      const leaves = i >= h - 3 ? (i >= h - 1 ? 'large' : 'small') : 'none';
      g.set(x, y + i, z, this.reg.state('bamboo', { age: '1', leaves, stage: '0' }));
    }
    return true;
  }
  private vines(g: GenAccess, x: number, y: number, z: number): boolean {
    if (!this.isAir(g.get(x, y, z))) return false;
    for (const [dx, dz, face] of [[1, 0, 'east'], [-1, 0, 'west'], [0, 1, 'south'], [0, -1, 'north']] as [number, number, string][]) {
      if (this.solid(g.get(x + dx, y, z + dz))) { g.set(x, y, z, this.reg.state('vine', { [face]: 'true' })); return true; }
    }
    return false;
  }
  private multiface(c: any, g: GenAccess, r: RandomSource, x: number, y: number, z: number): boolean {
    if (!this.isAir(g.get(x, y, z))) return false;
    const block = (c.block ?? 'minecraft:glow_lichen').replace('minecraft:', '');
    const faces: [number, number, number, string][] = [[0, -1, 0, 'down'], [0, 1, 0, 'up'], [1, 0, 0, 'east'], [-1, 0, 0, 'west'], [0, 0, 1, 'south'], [0, 0, -1, 'north']];
    const opts = faces.filter(([dx, dy, dz, f]) => (dy === 1 ? c.can_place_on_ceiling : dy === -1 ? c.can_place_on_floor : c.can_place_on_wall) !== false && this.solid(g.get(x + dx, y + dy, z + dz)) && f);
    if (!opts.length) return false;
    const f = opts[r.nextInt(opts.length)];
    g.set(x, y, z, this.reg.state(block, { [f[3]]: 'true' }));
    return true;
  }
  private vegetationPatch(c: any, g: GenAccess, r: RandomSource, x: number, y: number, z: number, water: boolean): boolean {
    const ground = this.provider(c.ground_state); const replaceable = this.tags.block(c.replaceable);
    const rx = sampleInt(c.xz_radius, r) + 1, rz = sampleInt(c.xz_radius, r) + 1;
    const depth = sampleInt(c.depth, r);
    for (let dx = -rx; dx <= rx; dx++) for (let dz = -rz; dz <= rz; dz++) {
      const edge = Math.abs(dx) === rx || Math.abs(dz) === rz;
      if (edge && r.nextFloat() > (c.extra_edge_column_chance ?? 0)) continue;
      let yy = y;
      while (yy > y - 3 && this.isAir(g.get(x + dx, yy - 1, z + dz))) yy--;
      for (let d = 0; d < depth; d++) {
        const s = g.get(x + dx, yy - 1 - d, z + dz);
        if (!replaceable.has(this.reg.stateBlock[s])) break;
        g.set(x + dx, yy - 1 - d, z + dz, ground(r, x + dx, yy - 1 - d, z + dz, g));
      }
      if (water && !edge) g.set(x + dx, yy - 1, z + dz, this.reg.state('water'));
      if (c.vegetation_feature && r.nextFloat() < (c.vegetation_chance ?? 0)) this.placeFeature(this.placed(c.vegetation_feature) ?? { feature: c.vegetation_feature, placement: [] }, g, r, x + dx, yy, z + dz, '', false);
    }
    return true;
  }
  private blockBlob(c: any, g: GenAccess, r: RandomSource, x: number, y: number, z: number): boolean {
    const s = this.stateOf(c.state);
    for (let i = 0; i < 3; i++) {
      const a = r.nextInt(2), b = r.nextInt(2), cc = r.nextInt(2);
      const f = (a + b + cc) * 0.333 + 0.5;
      for (let dx = -a; dx <= a; dx++) for (let dy = -b; dy <= b; dy++) for (let dz = -cc; dz <= cc; dz++) if (dx * dx + dy * dy + dz * dz <= f * f) g.set(x + dx, y + dy, z + dz, s);
      x += -1 + r.nextInt(2); y -= r.nextInt(2); z += -1 + r.nextInt(2);
    }
    return true;
  }
}

function h2(r: RandomSource): number { return r.nextInt(3) * 0 + 1; }

/** FancyTrunkPlacer.treeShape */
function treeShape(height: number, y: number): number {
  if (y < height * 0.3) return -1;
  const f = height / 2, g = f - y;
  let h = Math.sqrt(f * f - g * g);
  if (g === 0) h = f; else if (Math.abs(g) >= f) return 0;
  return h * 0.5;
}
import { SimplexNoise } from '../util/simplex';
import { JavaRandom } from '../util/javarandom';
let BIOME_INFO: SimplexNoise | null = null;
/** Biome.BIOME_INFO_NOISE (used by noise_threshold_count / noise_based_count). */
export function biomeInfoNoise(x: number, z: number): number {
  if (!BIOME_INFO) BIOME_INFO = new SimplexNoise(new JavaRandom(2345n));
  return BIOME_INFO.getValue(x, z);
}
