// Entity movement and collision (Entity.move / collide / LivingEntity.travel), in block units per tick.
import type { World } from '../world/world';
import type { BlockProps, AABB } from './blockprops';
import type { BlockRegistry } from '../world/registry';

export interface Box { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }

export class PhysicsWorld {
  constructor(readonly world: World, readonly props: BlockProps, readonly reg: BlockRegistry) {}
  /** All collision boxes intersecting a region. */
  boxes(b: Box, out: AABB[] = []): AABB[] {
    out.length = 0;
    const x0 = Math.floor(b.x0) - 1, y0 = Math.floor(b.y0) - 1, z0 = Math.floor(b.z0) - 1;
    const x1 = Math.floor(b.x1) + 1, y1 = Math.floor(b.y1) + 1, z1 = Math.floor(b.z1) + 1;
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
      const s = this.world.getStateOrUnloaded(x, y, z);
      if (s < 0) { out.push([x, y, z, x + 1, y + 1, z + 1]); continue; } // unloaded chunks are solid (vanilla blocks movement into them)
      if (s === 0) continue;
      for (const c of this.props.collision(s)) {
        const bx: AABB = [x + c[0], y + c[1], z + c[2], x + c[3], y + c[4], z + c[5]];
        if (bx[3] > b.x0 && bx[0] < b.x1 && bx[4] > b.y0 && bx[1] < b.y1 && bx[5] > b.z0 && bx[2] < b.z1) out.push(bx);
      }
    }
    return out;
  }
}

const EPS = 1e-7;
/** Shapes.collide along one axis: clip movement d so box doesn't penetrate any of the boxes. */
function clipAxis(axis: 0 | 1 | 2, b: Box, boxes: AABB[], d: number): number {
  if (Math.abs(d) < EPS) return 0;
  for (const c of boxes) {
    // overlap on the other two axes
    if (axis !== 0 && !(c[3] > b.x0 + EPS && c[0] < b.x1 - EPS)) continue;
    if (axis !== 1 && !(c[4] > b.y0 + EPS && c[1] < b.y1 - EPS)) continue;
    if (axis !== 2 && !(c[5] > b.z0 + EPS && c[2] < b.z1 - EPS)) continue;
    const lo = axis === 0 ? b.x0 : axis === 1 ? b.y0 : b.z0, hi = axis === 0 ? b.x1 : axis === 1 ? b.y1 : b.z1;
    const cl = c[axis], ch = c[axis + 3];
    if (d > 0 && cl >= hi - EPS) d = Math.min(d, cl - hi);
    else if (d < 0 && ch <= lo + EPS) d = Math.max(d, ch - lo);
  }
  return Math.abs(d) < EPS ? 0 : d;
}
const shift = (b: Box, x: number, y: number, z: number): Box => ({ x0: b.x0 + x, y0: b.y0 + y, z0: b.z0 + z, x1: b.x1 + x, y1: b.y1 + y, z1: b.z1 + z });

export class Entity {
  x = 0; y = 0; z = 0; xo = 0; yo = 0; zo = 0;
  vx = 0; vy = 0; vz = 0;
  yaw = 0; pitch = 0; yawO = 0; pitchO = 0;
  width = 0.6; height = 1.8;
  onGround = false; horizontalCollision = false; verticalCollision = false; collidedBelow = false;
  fallDistance = 0;
  stepHeight = 0.6;
  inWater = false; inLava = false; eyeInWater = false; waterHeight = 0; lavaHeight = 0;
  noPhysics = false;
  removed = false;
  tickCount = 0;
  private tmp: AABB[] = [];
  constructor(readonly phys: PhysicsWorld) {}

  get box(): Box { const w = this.width / 2; return { x0: this.x - w, y0: this.y, z0: this.z - w, x1: this.x + w, y1: this.y + this.height, z1: this.z + w }; }
  setPos(x: number, y: number, z: number): void { this.x = x; this.y = y; this.z = z; }

  /** Entity.collide: Y first, then the larger horizontal axis first; step-up when blocked horizontally. */
  private collide(dx: number, dy: number, dz: number): [number, number, number] {
    const b = this.box;
    const region: Box = { x0: Math.min(b.x0, b.x0 + dx), y0: Math.min(b.y0, b.y0 + dy), z0: Math.min(b.z0, b.z0 + dz), x1: Math.max(b.x1, b.x1 + dx), y1: Math.max(b.y1, b.y1 + dy), z1: Math.max(b.z1, b.z1 + dz) };
    const boxes = this.phys.boxes(region, this.tmp);
    const resolve = (bb: Box, mx: number, my: number, mz: number): [number, number, number] => {
      let cur = bb;
      const ry = clipAxis(1, cur, boxes, my); cur = shift(cur, 0, ry, 0);
      let rx: number, rz: number;
      if (Math.abs(mx) < Math.abs(mz)) { rz = clipAxis(2, cur, boxes, mz); cur = shift(cur, 0, 0, rz); rx = clipAxis(0, cur, boxes, mx); }
      else { rx = clipAxis(0, cur, boxes, mx); cur = shift(cur, rx, 0, 0); rz = clipAxis(2, cur, boxes, mz); }
      return [rx, ry, rz];
    };
    let [rx, ry, rz] = resolve(b, dx, dy, dz);
    const blockedX = rx !== dx, blockedZ = rz !== dz;
    const landing = this.onGround || (ry !== dy && dy < 0);
    if (this.stepHeight > 0 && landing && (blockedX || blockedZ)) {
      const stepRegion: Box = { x0: region.x0, y0: region.y0, z0: region.z0, x1: region.x1, y1: region.y1 + this.stepHeight, z1: region.z1 };
      const sb = this.phys.boxes(stepRegion, []);
      const up = clipAxis(1, b, sb, this.stepHeight);
      let cur = shift(b, 0, up, 0);
      let sx: number, sz: number;
      if (Math.abs(dx) < Math.abs(dz)) { sz = clipAxis(2, cur, sb, dz); cur = shift(cur, 0, 0, sz); sx = clipAxis(0, cur, sb, dx); cur = shift(cur, sx, 0, 0); }
      else { sx = clipAxis(0, cur, sb, dx); cur = shift(cur, sx, 0, 0); sz = clipAxis(2, cur, sb, dz); cur = shift(cur, 0, 0, sz); }
      const down = clipAxis(1, cur, sb, -up + (dy < 0 ? dy : 0));
      const sy = up + down;
      if (sx * sx + sz * sz > rx * rx + rz * rz + 1e-9) { rx = sx; ry = sy; rz = sz; }
    }
    return [rx, ry, rz];
  }

  /** Entity.move */
  move(dx: number, dy: number, dz: number, sneakGuard = false): void {
    if (this.noPhysics) { this.x += dx; this.y += dy; this.z += dz; return; }
    if (sneakGuard && this.onGround) [dx, dz] = this.backOffFromEdge(dx, dz);
    const [rx, ry, rz] = this.collide(dx, dy, dz);
    this.x += rx; this.y += ry; this.z += rz;
    const hx = Math.abs(rx - dx) > 1e-5, hz = Math.abs(rz - dz) > 1e-5;
    this.horizontalCollision = hx || hz;
    this.verticalCollision = ry !== dy;
    this.collidedBelow = this.verticalCollision && dy < 0;
    const wasOnGround = this.onGround;
    this.onGround = this.collidedBelow;
    if (hx) this.vx = 0;
    if (hz) this.vz = 0;
    if (this.verticalCollision) this.vy = 0;
    // fall distance (Entity.checkFallDamage)
    if (this.onGround) {
      if (this.fallDistance > 0 && !wasOnGround) this.onLand(this.fallDistance);
      this.fallDistance = 0;
    } else if (ry < 0) this.fallDistance -= ry;
    // block speed factor (soul sand, honey)
    const below = this.phys.world.getState(Math.floor(this.x), Math.floor(this.y - 0.5000001), Math.floor(this.z));
    const here = this.phys.world.getState(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z));
    const bf = this.phys.props.speedFactor[this.phys.reg.stateBlock[here]];
    const f = bf !== 1 || this.phys.reg.name(here) === 'water' ? bf : this.phys.props.speedFactor[this.phys.reg.stateBlock[below]];
    this.vx *= f; this.vz *= f;
  }

  /** Player.maybeBackOffFromEdge: shrink horizontal movement so a sneaking player doesn't step off. */
  private backOffFromEdge(dx: number, dz: number): [number, number] {
    const step = 0.05;
    const free = (ox: number, oz: number) => this.phys.boxes(shift(this.box, ox, -this.stepHeight - 1e-3, oz), []).length === 0
      || this.phys.boxes({ ...shift(this.box, ox, -this.stepHeight, oz), y1: this.box.y0 }, []).length === 0;
    while (dx !== 0 && free(dx, 0)) { if (Math.abs(dx) < step) { dx = 0; break; } dx -= Math.sign(dx) * step; }
    while (dz !== 0 && free(0, dz)) { if (Math.abs(dz) < step) { dz = 0; break; } dz -= Math.sign(dz) * step; }
    while (dx !== 0 && dz !== 0 && free(dx, dz)) {
      dx = Math.abs(dx) < step ? 0 : dx - Math.sign(dx) * step;
      dz = Math.abs(dz) < step ? 0 : dz - Math.sign(dz) * step;
    }
    return [dx, dz];
  }

  onLand(_dist: number): void { /* overridden */ }

  /** Fluid state around the entity (updateInWaterStateAndDoFluidPushing). */
  updateFluids(eyeHeight: number): void {
    const b = this.box;
    let wh = 0, lh = 0;
    const reg = this.phys.reg, w = this.phys.world;
    for (let x = Math.floor(b.x0 + 0.001); x <= Math.floor(b.x1 - 0.001); x++) for (let z = Math.floor(b.z0 + 0.001); z <= Math.floor(b.z1 - 0.001); z++)
      for (let y = Math.floor(b.y0 + 0.001); y <= Math.floor(b.y1 - 0.001); y++) {
        const s = w.getState(x, y, z);
        const n = reg.name(s);
        const water = n === 'water' || reg.prop(s, 'waterlogged') === 'true' || n === 'bubble_column' || n === 'kelp' || n === 'kelp_plant' || n === 'seagrass' || n === 'tall_seagrass';
        if (!water && n !== 'lava') continue;
        const lvl = +(reg.prop(s, 'level') ?? 0);
        const above = reg.name(w.getState(x, y + 1, z));
        const h = above === n ? 1 : lvl >= 8 ? 1 : (8 - lvl) / 9;
        const top = y + h;
        if (top > b.y0) { if (water) wh = Math.max(wh, top - b.y0); else lh = Math.max(lh, top - b.y0); }
      }
    this.waterHeight = wh; this.lavaHeight = lh;
    this.inWater = wh > 0; this.inLava = lh > 0;
    const ey = this.y + eyeHeight;
    const es = w.getState(Math.floor(this.x), Math.floor(ey), Math.floor(this.z));
    const en = reg.name(es);
    if (en === 'water' || reg.prop(es, 'waterlogged') === 'true' || en === 'bubble_column' || en === 'kelp' || en === 'kelp_plant' || en === 'seagrass' || en === 'tall_seagrass') {
      const lvl = +(reg.prop(es, 'level') ?? 0);
      const above = reg.name(w.getState(Math.floor(this.x), Math.floor(ey) + 1, Math.floor(this.z)));
      const h = above === 'water' ? 1 : lvl >= 8 ? 1 : (8 - lvl) / 9;
      this.eyeInWater = ey < Math.floor(ey) + h - 0.11111111;
    } else this.eyeInWater = false;
    if (this.inWater) this.fallDistance = 0;
    if (this.inLava) this.fallDistance *= 0.5;
  }

  onClimbable(): boolean {
    const s = this.phys.world.getState(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z));
    return this.phys.props.climbable.has(this.phys.reg.stateBlock[s]);
  }

  blockBelowFriction(): number {
    const s = this.phys.world.getState(Math.floor(this.x), Math.floor(this.y - 0.5000001), Math.floor(this.z));
    return this.phys.props.friction[this.phys.reg.stateBlock[s]];
  }
}

/** Entity.moveRelative / getInputVector */
export function inputVector(strafe: number, forward: number, speed: number, yawDeg: number): [number, number] {
  const d = strafe * strafe + forward * forward;
  if (d < 1e-7) return [0, 0];
  let sx = strafe, sz = forward;
  if (d > 1) { const l = Math.sqrt(d); sx /= l; sz /= l; }
  sx *= speed; sz *= speed;
  const s = Math.sin((yawDeg * Math.PI) / 180), c = Math.cos((yawDeg * Math.PI) / 180);
  return [sx * c - sz * s, sz * c + sx * s];
}
