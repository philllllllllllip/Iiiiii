// Light engine. Vanilla rules (LightEngine / SkyLightEngine / BlockLightEngine):
//  * block light: emitters seed their emission, each step loses max(1, lightBlock(target))
//  * sky light: 15 from the top of the world, travels straight down without loss through blocks that
//    propagate skylight (lightBlock 0); every other step loses max(1, lightBlock(target))
//  * useShapeForLightOcclusion: light cannot cross a face where the union of both blocks' face shapes
//    covers the whole face (e.g. into the bottom of a bottom slab)
import { Chunk, MIN_Y, HEIGHT, idx } from './chunk';
import type { World } from './world';
import type { BlockInfo } from './blockinfo';

const DX = [0, 0, 0, 0, -1, 1], DY = [-1, 1, 0, 0, 0, 0], DZ = [0, 0, -1, 1, 0, 0];
const TOP = MIN_Y + HEIGHT;

type Channel = 0 | 1; // 0 sky, 1 block

export class LightEngine {
  private qx = new Int32Array(1 << 20); private qy = new Int32Array(1 << 20); private qz = new Int32Array(1 << 20);
  private ql = new Uint8Array(1 << 20);
  constructor(readonly world: World, readonly info: BlockInfo) {}

  private arr(c: Chunk, ch: Channel, y: number): Uint8Array {
    const s = c.sections[(y - MIN_Y) >> 4];
    return ch === 0 ? s.sky : s.block;
  }
  private get(ch: Channel, x: number, y: number, z: number): number {
    if (y < MIN_Y) return 0;
    if (y >= TOP) return ch === 0 ? 15 : 0;
    const c = this.world.getChunk(x >> 4, z >> 4);
    if (!c) return -1;
    return this.arr(c, ch, y)[idx(x & 15, (y - MIN_Y) & 15, z & 15)];
  }
  private set(ch: Channel, x: number, y: number, z: number, v: number): void {
    const c = this.world.getChunk(x >> 4, z >> 4)!;
    this.arr(c, ch, y)[idx(x & 15, (y - MIN_Y) & 15, z & 15)] = v;
    this.world.markDirty(x, y, z);
  }

  /** Can light pass from state a to neighbour state b across direction d? */
  private passes(a: number, b: number, d: number): boolean {
    const fm = this.info.faceMask;
    const ma = fm[a * 6 + d], mb = fm[b * 6 + (d ^ 1)];
    if (ma === 0 || mb === 0) return ma !== 1 && mb !== 1 ? true : false;
    if (ma === 1 || mb === 1) return false;
    const A = this.info.masks[ma], B = this.info.masks[mb];
    for (let i = 0; i < 8; i++) if (((A[i] | B[i]) >>> 0) !== 0xffffffff) return true;
    return false;
  }

  private propagate(ch: Channel, head: number, tail: number): void {
    const { qx, qy, qz, ql } = this;
    const info = this.info; const world = this.world;
    const cap = qx.length - 1;
    while (head !== tail) {
      const x = qx[head], y = qy[head], z = qz[head], l = ql[head];
      head = (head + 1) & cap;
      if (this.get(ch, x, y, z) !== l) continue; // superseded
      const s = world.getState(x, y, z);
      for (let d = 0; d < 6; d++) {
        const nx = x + DX[d], ny = y + DY[d], nz = z + DZ[d];
        if (ny < MIN_Y || ny >= TOP) continue;
        const cur = this.get(ch, nx, ny, nz);
        if (cur < 0) continue;
        const t = world.getState(nx, ny, nz);
        const lb = info.lightBlock[t];
        if (lb >= 15) continue;
        let nl: number;
        if (ch === 0 && d === 0 && l === 15 && info.skyDown[t]) nl = 15;
        else nl = l - Math.max(1, lb);
        if (nl <= cur) continue;
        if (!this.passes(s, t, d)) continue;
        this.set(ch, nx, ny, nz, nl);
        qx[tail] = nx; qy[tail] = ny; qz[tail] = nz; ql[tail] = nl;
        tail = (tail + 1) & cap;
        if (tail === head) throw new Error('light queue overflow');
      }
    }
  }

  /** Full initial light for a freshly generated chunk, also pulling light in from lit neighbours. */
  lightChunk(c: Chunk): void {
    const info = this.info;
    const bx = c.cx << 4, bz = c.cz << 4;
    const { qx, qy, qz, ql } = this;
    // --- sky: direct column fill
    const skyTop = new Int16Array(256); // lowest y that has full sky light
    for (const s of c.sections) { s.sky.fill(0); s.block.fill(0); }
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      let y = TOP - 1;
      for (; y >= MIN_Y; y--) {
        const s = c.get(x, y, z);
        if (!info.skyDown[s]) break;
        // a downward-facing full face (e.g. top slab) also stops the column
        if (info.faceMask[s * 6 + 0] === 1 || info.faceMask[s * 6 + 1] === 1) break;
        const yy = y - MIN_Y;
        c.sections[yy >> 4].sky[idx(x, yy & 15, z)] = 15;
      }
      skyTop[z * 16 + x] = y + 1;
    }
    let tail = 0;
    const push = (x: number, y: number, z: number, l: number) => { qx[tail] = x; qy[tail] = y; qz[tail] = z; ql[tail] = l; tail++; };
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const h = skyTop[z * 16 + x];
      let maxN = h;
      for (const [ox, oz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + ox, nz = z + oz;
        if (nx >= 0 && nx < 16 && nz >= 0 && nz < 16) maxN = Math.max(maxN, skyTop[nz * 16 + nx]);
        else maxN = Math.max(maxN, TOP); // chunk border: seed fully, neighbour may be darker
      }
      for (let y = h; y < Math.min(maxN, TOP); y++) push(bx + x, y, bz + z, 15);
      if (h < TOP && h > MIN_Y) push(bx + x, h, bz + z, 15);
    }
    // pull light in from neighbouring chunks' border cells
    tail = this.seedFromNeighbours(c, 0, tail);
    this.propagate(0, 0, tail);
    // --- block light
    tail = 0;
    for (let si = 0; si < c.sections.length; si++) {
      const sec = c.sections[si];
      if (sec.nonAir === 0) continue;
      for (let i = 0; i < 4096; i++) {
        const e = info.emission[sec.states[i]];
        if (e > 0) {
          sec.block[i] = e;
          push(bx + (i & 15), MIN_Y + si * 16 + (i >> 8), bz + ((i >> 4) & 15), e);
        }
      }
    }
    tail = this.seedFromNeighbours(c, 1, tail);
    this.propagate(1, 0, tail);
    c.lit = true;
  }

  private seedFromNeighbours(c: Chunk, ch: Channel, tail: number): number {
    const { qx, qy, qz, ql } = this;
    const bx = c.cx << 4, bz = c.cz << 4;
    const sides: [number, number, number, number][] = [[-1, 0, 15, -1], [16, 0, 0, -1], [0, -1, -1, 15], [0, 16, -1, 0]];
    for (const [ox, oz, fx, fz] of sides) {
      const n = this.world.getChunk((bx + ox) >> 4, (bz + oz) >> 4);
      if (!n || !n.lit) continue;
      for (let y = MIN_Y; y < TOP; y++) {
        const sec = n.sections[(y - MIN_Y) >> 4];
        const arr = ch === 0 ? sec.sky : sec.block;
        for (let k = 0; k < 16; k++) {
          const lx = fx >= 0 ? fx : k, lz = fz >= 0 ? fz : k;
          const l = arr[idx(lx, (y - MIN_Y) & 15, lz)];
          if (l > 1) { qx[tail] = (n.cx << 4) + lx; qy[tail] = y; qz[tail] = (n.cz << 4) + lz; ql[tail] = l; tail++; }
        }
      }
    }
    return tail;
  }

  /** Incremental relight after a block at (x,y,z) changed. */
  onBlockChanged(x: number, y: number, z: number): void {
    for (const ch of [0, 1] as Channel[]) this.relight(ch, x, y, z);
  }

  private relight(ch: Channel, x: number, y: number, z: number): void {
    const { qx, qy, qz, ql } = this;
    const info = this.info; const world = this.world;
    const cap = qx.length - 1;
    // Removal pass
    const rx: number[] = [], ry: number[] = [], rz: number[] = [], rl: number[] = [];
    const old = this.get(ch, x, y, z);
    let addTail = 0;
    if (old > 0) { this.set(ch, x, y, z, 0); rx.push(x); ry.push(y); rz.push(z); rl.push(old); }
    let h = 0;
    while (h < rx.length) {
      const cx = rx[h], cy = ry[h], cz = rz[h], cl = rl[h]; h++;
      for (let d = 0; d < 6; d++) {
        const nx = cx + DX[d], ny = cy + DY[d], nz = cz + DZ[d];
        if (ny < MIN_Y || ny >= TOP) continue;
        const nl = this.get(ch, nx, ny, nz);
        if (nl <= 0) continue;
        const sameSkyColumn = ch === 0 && d === 0 && cl === 15 && nl === 15;
        if (nl < cl || sameSkyColumn) {
          this.set(ch, nx, ny, nz, 0);
          rx.push(nx); ry.push(ny); rz.push(nz); rl.push(nl);
        } else {
          qx[addTail] = nx; qy[addTail] = ny; qz[addTail] = nz; ql[addTail] = nl; addTail = (addTail + 1) & cap;
        }
      }
    }
    // Re-seed sources: the changed block's own emission, and sky from above
    const s = world.getState(x, y, z);
    if (ch === 1) {
      const e = info.emission[s];
      if (e > 0 && e > this.get(1, x, y, z)) { this.set(1, x, y, z, e); qx[addTail] = x; qy[addTail] = y; qz[addTail] = z; ql[addTail] = e; addTail = (addTail + 1) & cap; }
    } else {
      // Sky: if the column above is open sky, this cell (and the run below) regains 15
      if (this.get(0, x, y + 1, z) === 15 || y + 1 >= TOP) {
        let yy = y;
        while (yy >= MIN_Y) {
          const t = world.getState(x, yy, z);
          if (!info.skyDown[t] || info.faceMask[t * 6] === 1 || info.faceMask[t * 6 + 1] === 1) break;
          if (this.get(0, x, yy, z) === 15) break;
          this.set(0, x, yy, z, 15);
          qx[addTail] = x; qy[addTail] = yy; qz[addTail] = z; ql[addTail] = 15; addTail = (addTail + 1) & cap;
          yy--;
        }
      }
    }
    // Neighbours of removed cells re-propagate (already queued); also queue lit neighbours of the change
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d], ny = y + DY[d], nz = z + DZ[d];
      const nl = this.get(ch, nx, ny, nz);
      if (nl > 0) { qx[addTail] = nx; qy[addTail] = ny; qz[addTail] = nz; ql[addTail] = nl; addTail = (addTail + 1) & cap; }
    }
    this.propagate(ch, 0, addTail);
  }
}
