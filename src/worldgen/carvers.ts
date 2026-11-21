// CaveWorldCarver / CanyonWorldCarver driven by carver/*.json, with legacy (java.util.Random) seeding
// exactly as ChunkGenerator.applyCarvers: setLargeFeatureSeed(seed + index, chunkX, chunkZ).
import { JavaRandom } from '../util/javarandom';
import type { RandomSource } from './random';
import { sampleFloat } from './features';

export interface CarveTarget {
  cx: number; cz: number; minY: number; height: number;
  get(lx: number, y: number, lz: number): number;
  set(lx: number, y: number, lz: number, s: number): void;
  replaceable(s: number): boolean;
  isGrass(s: number): boolean; isDirt(s: number): boolean;
  air: number; lava: number; water: number; grass: number;
  sample(name: string, j: any, r: RandomSource): number; // height providers
  /** aquifer-aware: should carving at this position be filled with water instead of air */
  fluidAt(x: number, y: number, z: number): number;
}

const RANGE = 8;

function setLargeFeatureSeed(r: JavaRandom, seed: bigint, cx: number, cz: number): void {
  r.setSeed(seed);
  const a = r.nextLong(), b = r.nextLong();
  r.setSeed(BigInt.asIntN(64, (BigInt(cx) * a) ^ (BigInt(cz) * b) ^ seed));
}

export function applyCarvers(t: CarveTarget, seed: bigint, carvers: [string, any][]): void {
  const r = new JavaRandom(0);
  carvers.forEach(([, cfg], index) => {
    const type = String(cfg.type).replace('minecraft:', '');
    for (let dx = -RANGE; dx <= RANGE; dx++) for (let dz = -RANGE; dz <= RANGE; dz++) {
      const ox = t.cx + dx, oz = t.cz + dz;
      setLargeFeatureSeed(r, BigInt.asIntN(64, seed + BigInt(index)), ox, oz);
      if (r.nextFloat() > cfg.probability) continue;
      if (type === 'cave' || type === 'nether_cave') carveCave(t, cfg, r, ox, oz);
      else if (type === 'canyon') carveCanyon(t, cfg, r, ox, oz);
    }
  });
}

const rs = (r: JavaRandom) => r as unknown as RandomSource;

function carveCave(t: CarveTarget, c: any, r: JavaRandom, ox: number, oz: number): void {
  const i = (RANGE * 2 - 1) * 16;
  const count = t.sample('count', c.count ?? 15, rs(r));
  const j = r.nextInt(r.nextInt(Math.max(1, count + 1)) + 1);
  for (let k = 0; k < j; k++) {
    const d = ox * 16 + r.nextInt(16), e = t.sample('y', c.y, rs(r)), f = oz * 16 + r.nextInt(16);
    const hm = sampleFloat(c.horizontal_radius_multiplier, rs(r)), vm = sampleFloat(c.vertical_radius_multiplier, rs(r));
    const floor = sampleFloat(c.floor_level, rs(r));
    const skip = (rx: number, ry: number, rz: number) => ry <= floor || rx * rx + ry * ry + rz * rz >= 1;
    let m = 1;
    if (r.nextInt(4) === 0) {
      const yScale = sampleFloat(c.room_vertical_radius_multiplier ?? c.y_scale ?? 1, rs(r));
      const o = 1 + r.nextFloat() * 6;
      const hr = 1.5 + Math.sin(Math.PI / 2) * o;
      carveEllipsoid(t, d + 1, e, f, hr, hr * yScale, skip);
      m += r.nextInt(4);
    }
    for (let p = 0; p < m; p++) {
      const yaw = r.nextFloat() * Math.PI * 2, pitch = (r.nextFloat() - 0.5) / 4;
      let th = sampleFloat(c.thickness ?? 1, rs(r));
      if (c.weird_thickness_bias === undefined || c.weird_thickness_bias) {
        th = r.nextFloat() * 2 + r.nextFloat();
        if (r.nextInt(10) === 0) th *= r.nextFloat() * r.nextFloat() * 3 + 1;
      }
      const s = i - r.nextInt(i / 4 | 0);
      tunnel(t, r.nextLong(), d, e, f, hm, vm, th, yaw, pitch, 0, s, 1, skip);
    }
  }
}

function tunnel(t: CarveTarget, seed: bigint, x: number, y: number, z: number, hm: number, vm: number, th: number,
  yaw: number, pitch: number, start: number, count: number, yScale: number, skip: (a: number, b: number, c: number) => boolean): void {
  const r = new JavaRandom(seed);
  const i = r.nextInt((count / 2) | 0) + ((count / 4) | 0);
  const steep = r.nextInt(6) === 0;
  let f = 0, g = 0;
  for (let j = start; j < count; j++) {
    const d = 1.5 + Math.sin((Math.PI * j) / count) * th;
    const e = d * yScale;
    const h = Math.cos(pitch);
    x += Math.cos(yaw) * h; y += Math.sin(pitch); z += Math.sin(yaw) * h;
    pitch *= steep ? 0.92 : 0.7;
    pitch += g * 0.1; yaw += f * 0.1;
    g *= 0.9; f *= 0.75;
    g += (r.nextFloat() - r.nextFloat()) * r.nextFloat() * 2;
    f += (r.nextFloat() - r.nextFloat()) * r.nextFloat() * 4;
    if (j === i && th > 1) {
      tunnel(t, r.nextLong(), x, y, z, hm, vm, r.nextFloat() * 0.5 + 0.5, yaw - Math.PI / 2, pitch / 3, j, count, 1, skip);
      tunnel(t, r.nextLong(), x, y, z, hm, vm, r.nextFloat() * 0.5 + 0.5, yaw + Math.PI / 2, pitch / 3, j, count, 1, skip);
      return;
    }
    if (r.nextInt(4) !== 0) {
      const mx = t.cx * 16 + 8, mz = t.cz * 16 + 8;
      const dx = x - mx, dz = z - mz, rem = count - j, lim = th + 2 + 16;
      if (dx * dx + dz * dz - rem * rem > lim * lim) return;
      carveEllipsoid(t, x, y, z, d * hm, e * vm, skip);
    }
  }
}

function carveEllipsoid(t: CarveTarget, x: number, y: number, z: number, hr: number, vr: number,
  skip: (a: number, b: number, c: number) => boolean): void {
  const bx = t.cx * 16, bz = t.cz * 16;
  const mx = bx + 8, mz = bz + 8;
  const lim = 16 + hr * 2;
  if (Math.abs(x - mx) > lim || Math.abs(z - mz) > lim) return;
  const x0 = Math.max(Math.floor(x - hr) - bx - 1, 0), x1 = Math.min(Math.floor(x + hr) - bx, 15);
  const y0 = Math.max(Math.floor(y - vr) - 1, t.minY + 1), y1 = Math.min(Math.floor(y + vr) + 1, t.minY + t.height - 1 - 7);
  const z0 = Math.max(Math.floor(z - hr) - bz - 1, 0), z1 = Math.min(Math.floor(z + hr) - bz, 15);
  for (let lx = x0; lx <= x1; lx++) {
    const rx = (bx + lx + 0.5 - x) / hr;
    for (let lz = z0; lz <= z1; lz++) {
      const rz = (bz + lz + 0.5 - z) / hr;
      if (rx * rx + rz * rz >= 1) continue;
      let grassAbove = false;
      for (let yy = y1; yy > y0; yy--) {
        const ry = (yy - 0.5 - y) / vr;
        if (skip(rx, ry, rz)) continue;
        const s = t.get(lx, yy, lz);
        if (t.isGrass(s)) grassAbove = true;
        if (!t.replaceable(s)) continue;
        const fill = yy <= t.minY + 8 ? t.lava : t.fluidAt(bx + lx, yy, bz + lz);
        t.set(lx, yy, lz, fill);
        if (grassAbove && fill === t.air && t.isDirt(t.get(lx, yy - 1, lz))) t.set(lx, yy - 1, lz, t.grass);
      }
    }
  }
}

function carveCanyon(t: CarveTarget, c: any, r: JavaRandom, ox: number, oz: number): void {
  const i = (RANGE * 2 - 1) * 16;
  const d = ox * 16 + r.nextInt(16), e = t.sample('y', c.y, rs(r)), f = oz * 16 + r.nextInt(16);
  const yaw = r.nextFloat() * Math.PI * 2;
  const pitch = sampleFloat(c.vertical_rotation, rs(r));
  const yScale = sampleFloat(c.shape.y_scale ?? c.y_scale ?? 3, rs(r));
  const th = sampleFloat(c.shape.thickness, rs(r));
  const len = Math.floor(i * sampleFloat(c.shape.distance_factor, rs(r)));
  const seed = r.nextLong();
  const rr = new JavaRandom(seed);
  const widths: number[] = [];
  let ww = 1;
  for (let k = 0; k < t.height; k++) {
    if (k === 0 || rr.nextInt(c.shape.width_smoothness) === 0) ww = 1 + rr.nextFloat() * rr.nextFloat();
    widths.push(ww * ww);
  }
  let x = d, y = e, z = f, yw = yaw, pt = pitch, fa = 0, ga = 0;
  for (let j = 0; j < len; j++) {
    let dd = 1.5 + Math.sin((j * Math.PI) / len) * th;
    let ee = dd * yScale;
    dd *= sampleFloat(c.shape.horizontal_radius_factor, rs(rr));
    // CanyonWorldCarver.updateVerticalRadius
    const cf = 1 - Math.abs(0.5 - j / len) * 2;
    const vf = sampleFloat(c.shape.vertical_radius_default_factor, rs(rr)) + sampleFloat(c.shape.vertical_radius_center_factor, rs(rr)) * cf;
    ee = vf * ee * (0.75 + rr.nextFloat() * 0.25);
    const h = Math.cos(pt);
    x += Math.cos(yw) * h; y += Math.sin(pt); z += Math.sin(yw) * h;
    pt *= 0.7; pt += ga * 0.05; yw += fa * 0.05;
    ga *= 0.8; fa *= 0.5;
    ga += (rr.nextFloat() - rr.nextFloat()) * rr.nextFloat() * 2;
    fa += (rr.nextFloat() - rr.nextFloat()) * rr.nextFloat() * 4;
    if (rr.nextInt(4) === 0) continue;
    const mx = t.cx * 16 + 8, mz = t.cz * 16 + 8;
    const dx = x - mx, dz = z - mz, rem = len - j, lim = th + 2 + 16;
    if (dx * dx + dz * dz - rem * rem > lim * lim) return;
    const skip = (a: number, b: number, cc: number) => {
      const yy = Math.floor(y + b * ee) - t.minY;
      const w = widths[Math.max(0, Math.min(widths.length - 1, yy))];
      return (a * a + cc * cc) * w + (b * b) / 6 >= 1;
    };
    carveEllipsoid(t, x, y, z, dd, ee, skip);
  }
}
