// Block picking: walk the voxel grid along the view ray and test each block's outline shape
// (BlockGetter.clip with OUTLINE shapes, fluids ignored).
import type { World } from '../world/world';
import type { BlockProps } from './blockprops';

export interface Hit { x: number; y: number; z: number; face: number; hx: number; hy: number; hz: number; dist: number; state: number }
// face index: 0 down 1 up 2 north 3 south 4 west 5 east
export const FACE_VEC: [number, number, number][] = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];

export function raycast(world: World, props: BlockProps, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, reach: number): Hit | null {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity, tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity, tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tmx = dx > 0 ? (x + 1 - ox) * tdx : dx < 0 ? (ox - x) * tdx : Infinity;
  let tmy = dy > 0 ? (y + 1 - oy) * tdy : dy < 0 ? (oy - y) * tdy : Infinity;
  let tmz = dz > 0 ? (z + 1 - oz) * tdz : dz < 0 ? (oz - z) * tdz : Infinity;
  for (let i = 0; i < 64; i++) {
    const s = world.getState(x, y, z);
    if (s !== 0) {
      let best: Hit | null = null;
      for (const b of props.outline(s)) {
        const h = rayBox(ox, oy, oz, dx, dy, dz, x + b[0], y + b[1], z + b[2], x + b[3], y + b[4], z + b[5]);
        if (h && h[0] <= reach && (!best || h[0] < best.dist)) best = { x, y, z, face: h[1], hx: ox + dx * h[0], hy: oy + dy * h[0], hz: oz + dz * h[0], dist: h[0], state: s };
      }
      if (best) return best;
    }
    const t = Math.min(tmx, tmy, tmz);
    if (t > reach) return null;
    if (tmx === t) { x += sx; tmx += tdx; } else if (tmy === t) { y += sy; tmy += tdy; } else { z += sz; tmz += tdz; }
  }
  return null;
}

function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): [number, number] | null {
  let tmin = -Infinity, tmax = Infinity, face = -1;
  const ax = [[ox, dx, x0, x1, 4, 5], [oy, dy, y0, y1, 0, 1], [oz, dz, z0, z1, 2, 3]];
  for (const [o, d, lo, hi, fl, fh] of ax) {
    if (Math.abs(d) < 1e-12) { if (o < lo || o > hi) return null; continue; }
    let t1 = (lo - o) / d, t2 = (hi - o) / d, f1 = fl, f2 = fh;
    if (t1 > t2) { [t1, t2] = [t2, t1]; [f1, f2] = [f2, f1]; }
    if (t1 > tmin) { tmin = t1; face = f1; }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmin < 0) return null;
  return [tmin, face];
}
