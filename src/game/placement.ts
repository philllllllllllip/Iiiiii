// Block.getStateForPlacement and updateShape for the common state families (BlockItem placement).
import type { BlockRegistry } from '../world/registry';
import type { World } from '../world/world';
import type { BlockInfo } from '../world/blockinfo';
import type { Tags } from '../worldgen/features';
import { FACE_VEC } from './raycast';

const FACES = ['down', 'up', 'north', 'south', 'west', 'east'];
const HORIZ = ['north', 'east', 'south', 'west'];
const opposite = (d: string) => ({ north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' } as Record<string, string>)[d];
const clockwise = (d: string) => HORIZ[(HORIZ.indexOf(d) + 1) & 3];
const DV: Record<string, [number, number, number]> = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };

export interface PlaceContext {
  face: number; // clicked face index
  hx: number; hy: number; hz: number; // hit position (world)
  x: number; y: number; z: number; // target position
  yaw: number; pitch: number; sneaking: boolean;
}

export class Placement {
  constructor(readonly reg: BlockRegistry, readonly info: BlockInfo, readonly tags: Tags) {}

  /** Player's horizontal facing (Direction.fromYRot) */
  static horizontal(yaw: number): string { return HORIZ[(Math.floor((yaw * 4) / 360 + 0.5) + 2) & 3]; }
  /** nearest looking direction (context.getNearestLookingDirection) */
  static nearest(yaw: number, pitch: number): string {
    if (pitch < -45) return 'up';
    if (pitch > 45) return 'down';
    return Placement.horizontal(yaw);
  }

  private set(s: number, k: string, v: string): number { return this.reg.hasProp(s, k) && this.reg.block(s).props.find((p) => p[0] === k)![1].includes(v) ? this.reg.withProp(s, k, v) : s; }

  /** Returns the states to place: [[x,y,z,state],...] (multi-block for doors/beds/tall plants), or null if invalid. */
  forPlacement(base: number, w: World, c: PlaceContext): [number, number, number, number][] | null {
    const name = this.reg.name(base);
    const face = FACES[c.face];
    const hd = Placement.horizontal(c.yaw);
    const fracY = c.hy - c.y;
    let s = base;
    const props = this.reg.props(base);
    const existing = w.getState(c.x, c.y, c.z);
    const inWater = this.reg.name(existing) === 'water' && this.reg.prop(existing, 'level') === '0';
    if ('waterlogged' in props) s = this.set(s, 'waterlogged', inWater ? 'true' : 'false');

    if (name.endsWith('_slab')) {
      if (this.reg.name(existing) === name && this.reg.prop(existing, 'type') !== 'double') return [[c.x, c.y, c.z, this.set(this.set(existing, 'type', 'double'), 'waterlogged', 'false')]];
      const top = face === 'down' || (face !== 'up' && fracY > 0.5);
      return [[c.x, c.y, c.z, this.set(s, 'type', top ? 'top' : 'bottom')]];
    }
    if (name.endsWith('_stairs')) {
      s = this.set(s, 'facing', hd);
      s = this.set(s, 'half', face === 'down' || (face !== 'up' && fracY > 0.5) ? 'top' : 'bottom');
      return [[c.x, c.y, c.z, this.stairShape(w, c.x, c.y, c.z, s)]];
    }
    if (name.endsWith('_trapdoor')) {
      s = this.set(s, 'facing', face === 'up' || face === 'down' ? opposite(hd) : face);
      s = this.set(s, 'half', face === 'up' || (face !== 'down' && fracY <= 0.5) ? 'bottom' : 'top');
      return [[c.x, c.y, c.z, s]];
    }
    if (name.endsWith('_door')) {
      if (c.y >= 319 || !this.replaceable(w.getState(c.x, c.y + 1, c.z))) return null;
      s = this.set(s, 'facing', hd);
      // hinge: DoorBlock.getHinge (neighbour solidity / doors on either side)
      const left = DV[clockwise(clockwise(clockwise(hd)))], right = DV[clockwise(hd)];
      const solidL = this.info.solidRender[w.getState(c.x + left[0], c.y, c.z + left[2])] + this.info.solidRender[w.getState(c.x + left[0], c.y + 1, c.z + left[2])];
      const solidR = this.info.solidRender[w.getState(c.x + right[0], c.y, c.z + right[2])] + this.info.solidRender[w.getState(c.x + right[0], c.y + 1, c.z + right[2])];
      const doorL = this.reg.name(w.getState(c.x + left[0], c.y, c.z + left[2])).endsWith('_door');
      let hinge = 'left';
      if ((doorL && !this.reg.name(w.getState(c.x + right[0], c.y, c.z + right[2])).endsWith('_door')) || solidR > solidL) hinge = 'right';
      s = this.set(s, 'hinge', hinge);
      return [[c.x, c.y, c.z, this.set(s, 'half', 'lower')], [c.x, c.y + 1, c.z, this.set(s, 'half', 'upper')]];
    }
    if (name.endsWith('_bed')) {
      const d = DV[hd];
      if (!this.replaceable(w.getState(c.x + d[0], c.y, c.z + d[2]))) return null;
      s = this.set(s, 'facing', hd);
      return [[c.x, c.y, c.z, this.set(s, 'part', 'foot')], [c.x + d[0], c.y, c.z + d[2], this.set(s, 'part', 'head')]];
    }
    if ('half' in props && props.half === 'lower' && this.reg.block(base).props.find((p) => p[0] === 'half')![1].includes('upper')) {
      if (!this.replaceable(w.getState(c.x, c.y + 1, c.z))) return null;
      return [[c.x, c.y, c.z, s], [c.x, c.y + 1, c.z, this.set(s, 'half', 'upper')]];
    }
    if (/^(torch|soul_torch|redstone_torch|copper_torch)$/.test(name)) {
      if (face === 'up' || face === 'down') return [[c.x, c.y, c.z, s]];
      const wall = name === 'torch' ? 'wall_torch' : name.replace('torch', 'wall_torch');
      return [[c.x, c.y, c.z, this.set(this.reg.defaultState(wall), 'facing', face)]];
    }
    if (/_sign$/.test(name) && !/_wall_sign$|hanging/.test(name)) {
      if (face !== 'up' && face !== 'down') return [[c.x, c.y, c.z, this.set(this.reg.defaultState(name.replace('_sign', '_wall_sign')), 'facing', face)]];
      return [[c.x, c.y, c.z, this.set(s, 'rotation', String(Math.floor(((c.yaw + 180) * 16) / 360 + 0.5) & 15))]];
    }
    if (/_banner$/.test(name) || /_head$|_skull$/.test(name)) {
      if (face !== 'up' && face !== 'down') {
        const wall = name.replace(/_banner$/, '_wall_banner').replace(/_head$/, '_wall_head').replace(/_skull$/, '_wall_skull');
        if (this.reg.byName.has(wall)) return [[c.x, c.y, c.z, this.set(this.reg.defaultState(wall), 'facing', face)]];
      }
      return [[c.x, c.y, c.z, this.set(s, 'rotation', String(Math.floor(((c.yaw + 180) * 16) / 360 + 0.5) & 15))]];
    }
    if ('face' in props && 'facing' in props) { // buttons, levers, grindstone
      const fv = face === 'up' ? 'floor' : face === 'down' ? 'ceiling' : 'wall';
      s = this.set(s, 'face', fv);
      return [[c.x, c.y, c.z, this.set(s, 'facing', fv === 'wall' ? face : hd)]];
    }
    if ('axis' in props) {
      const ax = face === 'up' || face === 'down' ? 'y' : face === 'north' || face === 'south' ? 'z' : 'x';
      return [[c.x, c.y, c.z, this.set(s, 'axis', ax)]];
    }
    if ('facing' in props) {
      const vals = this.reg.block(base).props.find((p) => p[0] === 'facing')![1];
      let f: string;
      if (/^(ladder|wall_torch|.*_wall_.*|tripwire_hook|cocoa)$/.test(name)) { if (face === 'up' || face === 'down') return null; f = face; }
      else if (/^(piston|sticky_piston|dispenser|dropper|observer|crafter|barrel|end_rod|lightning_rod|.*_lightning_rod|amethyst_cluster|.*amethyst_bud|shulker_box|.*_shulker_box)$/.test(name)) {
        if (/^(end_rod|lightning_rod|.*_lightning_rod|amethyst_cluster|.*amethyst_bud|shulker_box|.*_shulker_box)$/.test(name)) f = face;
        else f = name === 'observer' ? Placement.nearest(c.yaw, c.pitch) : opposite(Placement.nearest(c.yaw, c.pitch));
      } else if (/_fence_gate$/.test(name)) f = hd;
      else if (/anvil$/.test(name)) f = clockwise(hd);
      else f = opposite(hd);
      if (!vals.includes(f)) f = vals.includes(opposite(hd)) ? opposite(hd) : vals[0];
      s = this.set(s, 'facing', f);
    }
    if ('rotation' in props) s = this.set(s, 'rotation', String(Math.floor(((c.yaw + 180) * 16) / 360 + 0.5) & 15));
    return [[c.x, c.y, c.z, this.updateShape(w, c.x, c.y, c.z, s)]];
  }

  replaceable(s: number): boolean {
    if (s === 0) return true;
    return this.tags.has('replaceable', s);
  }

  /** Recompute connection states of a block from its neighbours (Block.updateShape for connectables). */
  updateShape(w: World, x: number, y: number, z: number, s: number): number {
    const name = this.reg.name(s);
    if (name.endsWith('_stairs')) return this.stairShape(w, x, y, z, s);
    const fence = name.endsWith('_fence'), pane = name.endsWith('_pane') || name === 'glass_pane' || name === 'iron_bars' || name.endsWith('_bars'), wall = name.endsWith('_wall');
    if (fence || pane || wall) {
      const conn: Record<string, boolean> = {};
      for (const d of HORIZ) {
        const v = DV[d]; const n = w.getState(x + v[0], y, z + v[2]); const nn = this.reg.name(n);
        const sturdy = this.info.faceMask[n * 6 + FACES.indexOf(opposite(d))] === 1;
        let c = sturdy && !nn.endsWith('_leaves');
        if (fence) c ||= (nn.endsWith('_fence') && (nn === 'nether_brick_fence') === (name === 'nether_brick_fence')) || (nn.endsWith('_fence_gate') && ((this.reg.prop(n, 'facing') === 'east' || this.reg.prop(n, 'facing') === 'west') === (d === 'north' || d === 'south')));
        if (pane) c ||= nn.endsWith('_pane') || nn === 'glass_pane' || nn === 'iron_bars' || nn.endsWith('_bars') || nn.endsWith('_wall');
        if (wall) c ||= nn.endsWith('_wall') || nn.endsWith('_pane') || nn === 'iron_bars' || (nn.endsWith('_fence_gate'));
        conn[d] = c;
      }
      let r = s;
      if (wall) {
        const above = w.getState(x, y + 1, z);
        const tall = this.info.faceMask[above * 6] === 1;
        for (const d of HORIZ) r = this.set(r, d, conn[d] ? (tall ? 'tall' : 'low') : 'none');
        const straight = (conn.north && conn.south && !conn.east && !conn.west) || (conn.east && conn.west && !conn.north && !conn.south);
        r = this.set(r, 'up', straight && !tall ? 'false' : 'true');
      } else for (const d of HORIZ) r = this.set(r, d, conn[d] ? 'true' : 'false');
      return r;
    }
    if (name === 'redstone_wire') {
      let r = s;
      const conductive = (n: number) => { const nn = this.reg.name(n); return nn === 'redstone_wire' || /^(redstone_torch|redstone_wall_torch|redstone_block|lever|.*_button|.*_pressure_plate|repeater|comparator|observer|target|daylight_detector|trapped_chest|lectern|redstone_lamp_x|sculk_sensor|calibrated_sculk_sensor|tripwire_hook|lightning_rod)$/.test(nn); };
      for (const d of HORIZ) {
        const v = DV[d];
        const n = w.getState(x + v[0], y, z + v[2]);
        let side = 'none';
        if (conductive(n)) side = 'side';
        else if (!this.info.solidRender[n] && this.reg.name(w.getState(x + v[0], y - 1, z + v[2])) === 'redstone_wire') side = 'side';
        if (!this.info.solidRender[w.getState(x, y + 1, z)] && this.reg.name(w.getState(x + v[0], y + 1, z + v[2])) === 'redstone_wire') side = 'up';
        r = this.set(r, d, side);
      }
      // a lone dot connects in all directions (RedStoneWireBlock: dot shape when no connections)
      const any = HORIZ.some((d) => this.reg.prop(r, d) !== 'none');
      if (!any) for (const d of HORIZ) r = this.set(r, d, 'side');
      return r;
    }
    if (name === 'chest' || name === 'trapped_chest') return s;
    if (name === 'grass_block' || name === 'podzol' || name === 'mycelium') {
      const above = this.reg.name(w.getState(x, y + 1, z));
      return this.set(s, 'snowy', above === 'snow' || above === 'snow_block' || above === 'powder_snow' ? 'true' : 'false');
    }
    return s;
  }

  /** StairBlock.getStairsShape */
  private stairShape(w: World, x: number, y: number, z: number, s: number): number {
    const facing = this.reg.prop(s, 'facing')!, half = this.reg.prop(s, 'half');
    const isStair = (n: number) => this.reg.name(n).endsWith('_stairs');
    const at = (d: string) => { const v = DV[d]; return w.getState(x + v[0], y, z + v[2]); };
    const front = at(facing);
    if (isStair(front) && this.reg.prop(front, 'half') === half) {
      const f2 = this.reg.prop(front, 'facing')!;
      if (f2 !== facing && f2 !== opposite(facing)) {
        const side = at(opposite(f2));
        if (!(isStair(side) && this.reg.prop(side, 'facing') === facing && this.reg.prop(side, 'half') === half)) {
          return this.set(s, 'shape', f2 === HORIZ[(HORIZ.indexOf(facing) + 3) & 3] ? 'outer_left' : 'outer_right');
        }
      }
    }
    const back = at(opposite(facing));
    if (isStair(back) && this.reg.prop(back, 'half') === half) {
      const f3 = this.reg.prop(back, 'facing')!;
      if (f3 !== facing && f3 !== opposite(facing)) {
        const side = at(f3);
        if (!(isStair(side) && this.reg.prop(side, 'facing') === facing && this.reg.prop(side, 'half') === half)) {
          return this.set(s, 'shape', f3 === HORIZ[(HORIZ.indexOf(facing) + 3) & 3] ? 'inner_left' : 'inner_right');
        }
      }
    }
    return this.set(s, 'shape', 'straight');
  }

  /** States to update around (x,y,z) after a change: returns [x,y,z,newState] for neighbours that changed. */
  neighbourUpdates(w: World, x: number, y: number, z: number): [number, number, number, number][] {
    const out: [number, number, number, number][] = [];
    for (const v of FACE_VEC) {
      const nx = x + v[0], ny = y + v[1], nz = z + v[2];
      const n = w.getState(nx, ny, nz);
      if (n === 0) continue;
      const u = this.updateShape(w, nx, ny, nz, n);
      if (u !== n) out.push([nx, ny, nz, u]);
    }
    return out;
  }
}
