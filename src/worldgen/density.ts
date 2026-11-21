// Density function interpreter for 26.3 worldgen JSON (data/minecraft/worldgen/density_function).
// Functions compile to closures over block coordinates. `interpolated` nodes evaluate their input at
// cell corners and trilinearly interpolate (NoiseChunk cell interpolation); `cache` nodes memoise per
// position (per column when the subtree is independent of y). Call `newChunk()` between chunks.
import { NormalNoise, BlendedNoise, type NoiseParams } from './noise';
import type { PositionalRandomFactory } from './random';
import { SimplexNoise } from '../util/simplex';
import { JavaRandom } from '../util/javarandom';

export interface DF { (x: number, y: number, z: number): number; dy: boolean }

const mk = (f: (x: number, y: number, z: number) => number, dy: boolean): DF => Object.assign(f, { dy });
const key3 = (x: number, y: number, z: number) => ((x + 1048576) * 2097152 + (z + 1048576)) * 1024 + (y + 512);
const key2 = (x: number, z: number) => (x + 1048576) * 2097152 + (z + 1048576);

export class DensityContext {
  private compiled = new Map<string, DF>();
  private noises = new Map<string, NormalNoise>();
  private caches: Map<number, number>[] = [];
  private blended: BlendedNoise | null = null;
  private endIslands: SimplexNoise | null = null;

  constructor(readonly worldgen: Record<string, any>, readonly random: PositionalRandomFactory, readonly seed: bigint) {}

  epoch = 0;
  newChunk(): void { for (const c of this.caches) c.clear(); this.epoch++; }

  noise(name: string): NormalNoise {
    name = name.replace('minecraft:', '');
    let n = this.noises.get(name);
    if (!n) {
      const p = this.worldgen['noise/' + name] as NoiseParams;
      if (!p) throw new Error('missing noise ' + name);
      n = new NormalNoise(this.random.fromHashOf('minecraft:' + name), p);
      this.noises.set(name, n);
    }
    return n;
  }

  ref(name: string): DF {
    name = name.replace('minecraft:', '');
    let f = this.compiled.get(name);
    if (!f) {
      const j = this.worldgen['density_function/' + name];
      if (j === undefined) throw new Error('missing density function ' + name);
      f = this.compile(j);
      this.compiled.set(name, f);
    }
    return f;
  }

  private newCache(): Map<number, number> { const m = new Map<number, number>(); this.caches.push(m); return m; }

  compile(j: any): DF {
    if (typeof j === 'number') return mk(() => j, false);
    if (typeof j === 'string') return this.ref(j);
    const t = String(j.type).replace('minecraft:', '');
    const C = (v: any) => this.compile(v);
    const input = () => C(j.input ?? j.argument);
    switch (t) {
      case 'constant': { const v = j.argument; return mk(() => v, false); }
      case 'add': case 'mul': case 'min': case 'max': case 'sub': case 'div': {
        const a = C(j.left ?? j.argument1), b = C(j.right ?? j.argument2); const dy = a.dy || b.dy;
        switch (t) {
          case 'add': return mk((x, y, z) => a(x, y, z) + b(x, y, z), dy);
          case 'sub': return mk((x, y, z) => a(x, y, z) - b(x, y, z), dy);
          case 'mul': return mk((x, y, z) => { const v = a(x, y, z); return v === 0 ? 0 : v * b(x, y, z); }, dy);
          case 'div': return mk((x, y, z) => a(x, y, z) / b(x, y, z), dy);
          case 'min': return mk((x, y, z) => Math.min(a(x, y, z), b(x, y, z)), dy);
          default: return mk((x, y, z) => Math.max(a(x, y, z), b(x, y, z)), dy);
        }
      }
      case 'abs': { const a = input(); return mk((x, y, z) => Math.abs(a(x, y, z)), a.dy); }
      case 'negate': { const a = input(); return mk((x, y, z) => -a(x, y, z), a.dy); }
      case 'square': { const a = input(); return mk((x, y, z) => { const v = a(x, y, z); return v * v; }, a.dy); }
      case 'cube': { const a = input(); return mk((x, y, z) => { const v = a(x, y, z); return v * v * v; }, a.dy); }
      case 'half_negative': { const a = input(); return mk((x, y, z) => { const v = a(x, y, z); return v > 0 ? v : v * 0.5; }, a.dy); }
      case 'quarter_negative': { const a = input(); return mk((x, y, z) => { const v = a(x, y, z); return v > 0 ? v : v * 0.25; }, a.dy); }
      case 'squeeze': {
        const a = input();
        return mk((x, y, z) => { const e = Math.min(1, Math.max(-1, a(x, y, z))); return e / 2 - (e * e * e) / 24; }, a.dy);
      }
      case 'clamp': { const a = input(); const lo = j.min, hi = j.max; return mk((x, y, z) => Math.min(hi, Math.max(lo, a(x, y, z))), a.dy); }
      case 'gradient': case 'y_clamped_gradient': {
        const axis = j.axis ?? 'y';
        const c0 = j.from_coordinate ?? j.from_y, c1 = j.to_coordinate ?? j.to_y, v0 = j.from_value, v1 = j.to_value;
        const sel = axis === 'x' ? 0 : axis === 'z' ? 2 : 1;
        return mk((x, y, z) => {
          const c = sel === 0 ? x : sel === 1 ? y : z;
          const tt = (c - c0) / (c1 - c0);
          return tt <= 0 ? v0 : tt >= 1 ? v1 : v0 + tt * (v1 - v0);
        }, sel === 1);
      }
      case 'noise': {
        const n = this.noise(j.noise); const xz = j.xz_scale ?? 1, ys = j.y_scale ?? 1;
        const sx = j.shift_x !== undefined ? C(j.shift_x) : null, sy = j.shift_y !== undefined ? C(j.shift_y) : null, sz = j.shift_z !== undefined ? C(j.shift_z) : null;
        if (sx || sy || sz) {
          return mk((x, y, z) => n.getValue(x * xz + (sx ? sx(x, y, z) : 0), y * ys + (sy ? sy(x, y, z) : 0), z * xz + (sz ? sz(x, y, z) : 0)), ys !== 0 || !!(sy && sy.dy));
        }
        return mk((x, y, z) => n.getValue(x * xz, y * ys, z * xz), ys !== 0);
      }
      case 'shift_a': { const n = this.noise(j.noise ?? j.argument); return mk((x, _y, z) => n.getValue(x * 0.25, 0, z * 0.25) * 4, false); }
      case 'shift_b': { const n = this.noise(j.noise ?? j.argument); return mk((x, _y, z) => n.getValue(z * 0.25, x * 0.25, 0) * 4, false); }
      case 'shift': { const n = this.noise(j.noise ?? j.argument); return mk((x, y, z) => n.getValue(x * 0.25, y * 0.25, z * 0.25) * 4, true); }
      case 'old_blended_noise': {
        if (!this.blended) this.blended = new BlendedNoise(this.random.fromHashOf('minecraft:terrain'), j.xz_scale, j.y_scale, j.xz_factor, j.y_factor, j.smear_scale_multiplier);
        const b = this.blended;
        return mk((x, y, z) => b.compute(x, y, z), true);
      }
      case 'interpolated': {
        const a = input();
        const sxz = j.cell_size_xz ?? 4, sy = j.cell_size_y ?? 8;
        const cache = this.newCache();
        const corner = (x: number, y: number, z: number) => {
          const k = key3(x, y, z);
          let v = cache.get(k);
          if (v === undefined) { v = a(x, y, z); cache.set(k, v); }
          return v;
        };
        // last-cell fast path: blocks are visited column by column, so consecutive calls share a cell
        let lx = NaN, ly = NaN, lz = NaN, epoch = -1;
        const c = new Float64Array(8);
        return mk((x, y, z) => {
          const x0 = Math.floor(x / sxz) * sxz, y0 = Math.floor(y / sy) * sy, z0 = Math.floor(z / sxz) * sxz;
          if (x0 !== lx || y0 !== ly || z0 !== lz || epoch !== this.epoch) {
            lx = x0; ly = y0; lz = z0; epoch = this.epoch;
            const x1 = x0 + sxz, y1 = y0 + sy, z1 = z0 + sxz;
            c[0] = corner(x0, y0, z0); c[1] = corner(x1, y0, z0); c[2] = corner(x0, y1, z0); c[3] = corner(x1, y1, z0);
            c[4] = corner(x0, y0, z1); c[5] = corner(x1, y0, z1); c[6] = corner(x0, y1, z1); c[7] = corner(x1, y1, z1);
          }
          const fx = (x - x0) / sxz, fy = (y - y0) / sy, fz = (z - z0) / sxz;
          const a0 = c[0] + fx * (c[1] - c[0]), a1 = c[2] + fx * (c[3] - c[2]), a2 = c[4] + fx * (c[5] - c[4]), a3 = c[6] + fx * (c[7] - c[6]);
          const b0 = a0 + fy * (a1 - a0), b1 = a2 + fy * (a3 - a2);
          return b0 + fz * (b1 - b0);
        }, a.dy || sy > 1);
      }
      case 'cache': case 'flat_cache': case 'cache_2d': case 'cache_once': case 'cache_all_in_cell': {
        const a = input(); const cache = this.newCache();
        let lx = NaN, ly = NaN, lz = NaN, lv = 0, epoch = -1;
        if (!a.dy) return mk((x, _y, z) => {
          if (x === lx && z === lz && epoch === this.epoch) return lv;
          const k = key2(x, z); let v = cache.get(k); if (v === undefined) { v = a(x, 0, z); cache.set(k, v); }
          lx = x; lz = z; lv = v; epoch = this.epoch; return v;
        }, false);
        return mk((x, y, z) => {
          if (x === lx && y === ly && z === lz && epoch === this.epoch) return lv;
          const v = a(x, y, z); lx = x; ly = y; lz = z; lv = v; epoch = this.epoch; return v;
        }, true);
      }
      case 'slice': {
        const a = input(); const c = j.coordinate ?? 0; const axis = j.axis ?? 'y';
        if (axis === 'y') return mk((x, _y, z) => a(x, c, z), false);
        if (axis === 'x') return mk((_x, y, z) => a(c, y, z), a.dy);
        return mk((x, y) => a(x, y, c), a.dy);
      }
      case 'range_choice': {
        const a = input(), w = C(j.when_in_range), o = C(j.when_out_of_range); const lo = j.min_inclusive, hi = j.max_exclusive;
        return mk((x, y, z) => { const v = a(x, y, z); return v >= lo && v < hi ? w(x, y, z) : o(x, y, z); }, a.dy || w.dy || o.dy);
      }
      case 'interval_select': {
        const a = input(); const th: number[] = j.thresholds; const fs: DF[] = j.functions.map(C);
        return mk((x, y, z) => {
          const v = a(x, y, z); let i = 0;
          while (i < th.length && v >= th[i]) i++;
          return fs[i](x, y, z);
        }, a.dy || fs.some((f) => f.dy));
      }
      case 'lerp': {
        const al = C(j.alpha ?? j.delta), f1 = C(j.first ?? j.argument1), f2 = C(j.second ?? j.argument2);
        return mk((x, y, z) => { const t2 = al(x, y, z); return f1(x, y, z) + t2 * (f2(x, y, z) - f1(x, y, z)); }, al.dy || f1.dy || f2.dy);
      }
      case 'spline': { const s = this.spline(j.spline); return mk(s.f, s.dy); }
      case 'find_top_surface': {
        const d = C(j.density), ub = C(j.upper_bound); const lb = j.lower_bound, ch = j.cell_height;
        return mk((x, _y, z) => {
          const top = Math.floor(ub(x, 0, z) / ch) * ch;
          for (let y = top; y >= lb; y -= ch) if (d(x, y, z) > 0) return y;
          return lb;
        }, false);
      }
      case 'distance_to_point': {
        const p = j.point as number[];
        return mk((x, y, z) => Math.hypot(x - p[0], y - p[1], z - p[2]), true);
      }
      case 'end_outer_islands': {
        if (!this.endIslands) { const r = new JavaRandom(this.seed); for (let i = 0; i < 17292; i++) r.next(32); this.endIslands = new SimplexNoise(r); }
        const n = this.endIslands;
        return mk((x, _y, z) => (endHeight(n, Math.floor(x / 8), Math.floor(z / 8)) - 8) / 128, false);
      }
      case 'blend_alpha': return mk(() => 1, false);
      case 'blend_offset': return mk(() => 0, false);
      case 'blend_density': return input();
      case 'beardifier': return mk(() => 0, false);
      case 'weird_scaled_sampler': {
        const a = input(); const n = this.noise(j.noise); const type1 = j.rarity_value_mapper === 'type_1';
        return mk((x, y, z) => {
          const v = a(x, y, z);
          const r = type1 ? (v < -0.5 ? 0.75 : v < 0 ? 1 : v < 0.5 ? 1.5 : 2) : (v < -0.75 ? 0.5 : v < -0.5 ? 0.75 : v < 0.5 ? 1 : v < 0.75 ? 2 : 3);
          return r * Math.abs(n.getValue(x / r, y / r, z / r));
        }, true);
      }
      default: throw new Error('unsupported density function type ' + t);
    }
  }

  private spline(s: any): { f: (x: number, y: number, z: number) => number; dy: boolean } {
    if (typeof s === 'number') return { f: () => s, dy: false };
    const coord = this.compile(s.coordinate);
    const locs: number[] = s.points.map((p: any) => p.location);
    const ders: number[] = s.points.map((p: any) => p.derivative);
    const vals = s.points.map((p: any) => this.spline(p.value));
    const n = locs.length;
    const dy = coord.dy || vals.some((v: any) => v.dy);
    return {
      dy,
      f: (x, y, z) => {
        const c = coord(x, y, z);
        // findIntervalStart: index of last location <= c (binary search for first location > c, minus 1)
        let lo = 0, hi = n;
        while (lo < hi) { const m = (lo + hi) >> 1; if (c < locs[m]) hi = m; else lo = m + 1; }
        const i = lo - 1;
        if (i < 0) return vals[0].f(x, y, z) + ders[0] * (c - locs[0]);
        if (i === n - 1) return vals[n - 1].f(x, y, z) + ders[n - 1] * (c - locs[n - 1]);
        const l0 = locs[i], l1 = locs[i + 1];
        const t = (c - l0) / (l1 - l0);
        const y0 = vals[i].f(x, y, z), y1 = vals[i + 1].f(x, y, z);
        const p = ders[i] * (l1 - l0) - (y1 - y0), q = -ders[i + 1] * (l1 - l0) + (y1 - y0);
        return y0 + t * (y1 - y0) + t * (1 - t) * (p + t * (q - p));
      },
    };
  }
}

/** TheEndBiomeSource / DensityFunctions.EndIslandDensityFunction.getHeightValue */
function endHeight(n: SimplexNoise, i: number, j: number): number {
  const k = Math.floor(i / 2), l = Math.floor(j / 2), m = i % 2, o = j % 2;
  let f = 100 - Math.sqrt(i * i + j * j) * 8;
  f = Math.min(80, Math.max(-100, f));
  for (let p = -12; p <= 12; p++) for (let q = -12; q <= 12; q++) {
    const r = k + p, s = l + q;
    if (r * r + s * s > 4096 && n.getValue(r, s) < -0.9) {
      const g = ((Math.abs(r) * 3439 + Math.abs(s) * 147) % 13) + 9;
      const hx = m - p * 2, hz = o - q * 2;
      let h = 100 - Math.sqrt(hx * hx + hz * hz) * g;
      h = Math.min(80, Math.max(-100, h));
      f = Math.max(f, h);
    }
  }
  return f;
}
