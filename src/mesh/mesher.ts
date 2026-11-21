// Section mesher. Produces vertex data for the solid / cutout / translucent layers of one 16^3 section.
//
// Lighting follows vanilla ModelBlockRenderer:
//  * smooth lighting (AmbientOcclusionFace): per corner, sample the two in-plane neighbours, the
//    diagonal (only if one of the two sides is open) and the centre; brightness = mean of shade values
//    (0.2 for full-collision blocks, else 1.0); light = mean with zero samples replaced by the centre.
//  * flat lighting for ao:false models: light of the neighbour (boundary faces) or the block itself.
//  * directional shade: down 0.5, up 1.0, north/south 0.8, west/east 0.6.
// Liquids follow LiquidBlockRenderer (corner height averaging, flow direction, overlay sides).
// Greedy merging only joins faces whose four vertices carry identical colour and light and whose
// neighbours along the merge are identical, so merged output samples exactly like unmerged quads.
import type { BlockInfo } from '../world/blockinfo';
import { Tint } from '../world/blockinfo';
import type { BlockRegistry } from '../world/registry';
import type { Biomes } from '../world/biomes';
import { redstoneColor, stemColor } from '../world/biomes';
import { type BakedQuad, DIR_VEC } from './bake';
import { JavaRandom, getSeed } from '../util/javarandom';
import type { BlocksJson } from '../assets/types';

export const VERTEX_BYTES = 32;
export const SHADE = [0.5, 1.0, 0.8, 0.8, 0.6, 0.6];

export interface MeshSource {
  getState(x: number, y: number, z: number): number;
  sky(x: number, y: number, z: number): number;
  blockLight(x: number, y: number, z: number): number;
  biome(x: number, y: number, z: number): number;
}

export interface SectionMesh {
  layers: [ArrayBuffer, ArrayBuffer, ArrayBuffer];
  quads: [number, number, number];
  /** translucent quad centres (x,y,z per quad) for back-to-front sorting */
  centers: Float32Array;
}

class QuadBuffer {
  f = new Float32Array(8 * 4 * 64);
  u = new Uint32Array(this.f.buffer);
  n = 0; // quads
  centers: number[] = [];
  ensure(): void {
    if ((this.n + 1) * 32 > this.f.length) {
      const nf = new Float32Array(this.f.length * 2); nf.set(this.f); this.f = nf; this.u = new Uint32Array(nf.buffer);
    }
  }
  vertex(o: number, x: number, y: number, z: number, u: number, v: number, slot: number, color: number, light: number): void {
    this.f[o] = x; this.f[o + 1] = y; this.f[o + 2] = z; this.f[o + 3] = u; this.f[o + 4] = v;
    this.u[o + 5] = slot; this.u[o + 6] = color; this.u[o + 7] = light;
  }
  take(): ArrayBuffer { return this.f.buffer.slice(0, this.n * 4 * VERTEX_BYTES); }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
function packColor(rgb: number, mul: number, a = 255): number {
  const r = Math.round(((rgb >> 16) & 255) * mul), g = Math.round(((rgb >> 8) & 255) * mul), b = Math.round((rgb & 255) * mul);
  return (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
}

export interface MesherOptions { smoothLighting: boolean; biomeBlend: number; }

export class Mesher {
  private buf = [new QuadBuffer(), new QuadBuffer(), new QuadBuffer()];
  private rnd = new JavaRandom(0);
  private tintCache = new Map<number, number>();
  // liquid sprites
  private waterStill: number; private waterFlow: number; private waterOverlay: number;
  private lavaStill: number; private lavaFlow: number;

  constructor(
    readonly reg: BlockRegistry, readonly info: BlockInfo, readonly biomes: Biomes, readonly blocks: BlocksJson,
    /** sprite id -> packed texture slot (array << 16 | layer) */
    readonly spriteSlot: Uint32Array,
    spriteNames: string[],
    public opts: MesherOptions,
  ) {
    const find = (n: string) => { const i = spriteNames.indexOf(n); if (i < 0) throw new Error('sprite missing: ' + n); return i; };
    this.waterStill = find('block/water_still'); this.waterFlow = find('block/water_flow'); this.waterOverlay = find('block/water_overlay');
    this.lavaStill = find('block/lava_still'); this.lavaFlow = find('block/lava_flow');
  }

  private light(src: MeshSource, x: number, y: number, z: number): number {
    // LevelRenderer.getLightColor: sky | max(block, emission) in 0..240 units
    const s = src.getState(x, y, z);
    const sky = src.sky(x, y, z);
    const bl = Math.max(src.blockLight(x, y, z), this.info.emission[s]);
    return (bl << 4) | ((sky << 4) << 8);
  }

  private tintColor(src: MeshSource, state: number, tintIndex: number, x: number, y: number, z: number): number {
    const kind = this.info.tint[this.reg.stateBlock[state]] as Tint;
    if (kind === Tint.None) return 0xffffff;
    if (kind === Tint.Redstone) return redstoneColor(+(this.reg.prop(state, 'power') ?? 0));
    if (kind === Tint.Stem) return stemColor(+(this.reg.prop(state, 'age') ?? 0));
    if (kind === Tint.GrassSecondary && tintIndex === 0) return 0xffffff;
    if (kind === Tint.Evergreen || kind === Tint.Birch || kind === Tint.LilyPad || kind === Tint.AttachedStem) return this.biomes.color(kind, 0, x, z);
    // Double plants tint from the lower half
    let ty = y;
    if ((kind === Tint.Grass) && this.reg.prop(state, 'half') === 'upper') ty = y - 1;
    const key = ((kind * 4096 + ((x & 63) * 64 + (z & 63))) * 1024 + (ty & 1023));
    const c = this.tintCache.get(key);
    if (c !== undefined) return c;
    const r = this.opts.biomeBlend;
    let rs = 0, gs = 0, bs = 0, n = 0;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const col = this.biomes.color(kind, src.biome(x + dx, ty, z + dz), x + dx, z + dz);
      rs += (col >> 16) & 255; gs += (col >> 8) & 255; bs += col & 255; n++;
    }
    const out = ((rs / n) << 16) | ((gs / n) << 8) | (bs / n);
    this.tintCache.set(key, out);
    return out;
  }

  /** Select model parts for a state at a position (weighted variants seeded by Mth.getSeed). */
  private quadsFor(state: number, x: number, y: number, z: number, out: BakedQuad[][]): void {
    out.length = 0;
    const parts = this.blocks.states[state];
    let multiSeed: bigint | null = null;
    for (const pid of parts) {
      const choices = this.blocks.parts[pid];
      let ci = 0;
      if (choices.length > 1) {
        if (parts.length > 1) {
          if (multiSeed === null) { this.rnd.setSeed(getSeed(x, y, z)); multiSeed = this.rnd.nextLong(); }
          this.rnd.setSeed(multiSeed);
        } else this.rnd.setSeed(getSeed(x, y, z));
        let total = 0; for (const c of choices) total += c.w ?? 1;
        let pick = this.rnd.nextInt(total);
        for (ci = 0; ci < choices.length; ci++) { pick -= choices[ci].w ?? 1; if (pick < 0) break; }
      }
      out.push(this.info.baked(pid, ci));
    }
  }

  meshSection(src: MeshSource, sx: number, sy: number, sz: number): SectionMesh {
    for (const b of this.buf) { b.n = 0; b.centers.length = 0; }
    this.tintCache.clear();
    const ox = sx * 16, oy = sy * 16, oz = sz * 16;
    const info = this.info;
    const lists: BakedQuad[][] = [];
    // greedy candidates: per direction, per slice: cell -> key/data
    const greedy: Map<string, GreedyCell[]>[] = [new Map(), new Map(), new Map(), new Map(), new Map(), new Map()];
    for (let ly = 0; ly < 16; ly++) for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
      const x = ox + lx, y = oy + ly, z = oz + lz;
      const s = src.getState(x, y, z);
      if (s === 0 || info.airLike[s]) continue;
      if (info.fluid[s]) this.liquid(src, s, x, y, z, ox, oy, oz);
      if (info.layer[s] === 3) continue;
      this.quadsFor(s, x, y, z, lists);
      const bi = this.reg.stateBlock[s];
      let offX = 0, offY = 0, offZ = 0;
      if (info.offsetType[bi]) {
        const l = getSeed(x, 0, z);
        offX = clamp((Number(l & 15n) / 15 - 0.5) * 0.5, -0.25, 0.25);
        offZ = clamp((Number((l >> 8n) & 15n) / 15 - 0.5) * 0.5, -0.25, 0.25);
        if (info.offsetType[bi] === 2) offY = (Number((l >> 4n) & 15n) / 15 - 1) * 0.2;
      }
      const layer = info.layer[s];
      const neighbourCache = new Int32Array(6).fill(-2);
      for (const quads of lists) for (const q of quads) {
        if (q.cull >= 0) {
          let n = neighbourCache[q.cull];
          if (n === -2) { const v = DIR_VEC[q.cull]; n = src.getState(x + v[0], y + v[1], z + v[2]); neighbourCache[q.cull] = n; }
          if (n > 0 && info.faceHidden(s, q, n)) continue;
        }
        this.emitQuad(src, s, q, x, y, z, lx + offX, ly + offY, lz + offZ, q.translucent ? 2 : layer, greedy, offX === 0 && offY === 0 && offZ === 0);
      }
    }
    for (let d = 0; d < 6; d++) for (const [, cells] of greedy[d]) this.flushGreedy(d, cells);
    const quads: [number, number, number] = [this.buf[0].n, this.buf[1].n, this.buf[2].n];
    return {
      layers: [this.buf[0].take(), this.buf[1].take(), this.buf[2].take()],
      quads,
      centers: new Float32Array(this.buf[2].centers),
    };
  }

  private emitQuad(src: MeshSource, s: number, q: BakedQuad, x: number, y: number, z: number,
    bx: number, by: number, bz: number, layer: number, greedy: Map<string, GreedyCell[]>[], canGreedy: boolean): void {
    const info = this.info;
    const tint = q.tint >= 0 ? this.tintColor(src, s, q.tint, x, y, z) : 0xffffff;
    const shade = q.shade ? SHADE[q.shadeDir] : 1;
    const colors = [0, 0, 0, 0], lights = [0, 0, 0, 0];
    const d = q.dir; const nv = DIR_VEC[d];
    if (this.opts.smoothLighting && q.ao && info.emission[s] === 0) {
      // in-plane axes
      const ax = d < 2 ? 1 : d < 4 ? 2 : 0;
      const ua = ax === 0 ? 1 : 0, va = ax === 2 ? 1 : 2;
      const L = q.onBoundary ? [x + nv[0], y + nv[1], z + nv[2]] : [x, y, z];
      const front = [x + nv[0], y + nv[1], z + nv[2]];
      const frontState = src.getState(front[0], front[1], front[2]);
      const centerLight = q.onBoundary || !info.solidRender[frontState] ? this.light(src, front[0], front[1], front[2]) : this.light(src, x, y, z);
      const centerShade = q.onBoundary ? (info.shadeFull[frontState] ? 0.2 : 1) : (info.shadeFull[s] ? 0.2 : 1);
      const cornerAo = [0, 0, 0, 0], cornerLight = [0, 0, 0, 0];
      const sample = (p: number[]) => {
        const st = src.getState(p[0], p[1], p[2]);
        return { shade: info.shadeFull[st] ? 0.2 : 1, light: this.light(src, p[0], p[1], p[2]), open: !info.solidRender[st] || info.lightBlock[st] === 0 };
      };
      for (let c = 0; c < 4; c++) {
        const su = c & 1 ? 1 : -1, sv = c & 2 ? 1 : -1;
        const A = L.slice(); A[ua] += su;
        const B = L.slice(); B[va] += sv;
        const sa = sample(A), sb = sample(B);
        let sc: { shade: number; light: number };
        if (sa.open || sb.open) { const C = L.slice(); C[ua] += su; C[va] += sv; sc = sample(C); } else sc = sa;
        cornerAo[c] = (sa.shade + sb.shade + sc.shade + centerShade) * 0.25;
        cornerLight[c] = blendLight(sa.light, sb.light, sc.light, centerLight);
      }
      const pos = [0, 0, 0];
      for (let i = 0; i < 4; i++) {
        pos[0] = q.pos[i * 3]; pos[1] = q.pos[i * 3 + 1]; pos[2] = q.pos[i * 3 + 2];
        const fu = clamp01(pos[ua]), fv = clamp01(pos[va]);
        const w = [(1 - fu) * (1 - fv), fu * (1 - fv), (1 - fu) * fv, fu * fv];
        let ao = 0, bl = 0, sk = 0;
        for (let c = 0; c < 4; c++) { ao += cornerAo[c] * w[c]; bl += (cornerLight[c] & 255) * w[c]; sk += (cornerLight[c] >> 8) * w[c]; }
        let lb = Math.round(bl), ls = Math.round(sk);
        if (q.light) lb = Math.max(lb, q.light << 4);
        colors[i] = packColor(tint, shade * ao);
        lights[i] = lb | (ls << 8);
      }
    } else {
      const lp = q.onBoundary ? [x + nv[0], y + nv[1], z + nv[2]] : [x, y, z];
      let l = this.light(src, lp[0], lp[1], lp[2]);
      if (info.emission[s]) l = Math.max(l & 255, info.emission[s] << 4) | (l & 0xff00);
      if (q.light) l = Math.max(l & 255, q.light << 4) | (l & 0xff00);
      const c = packColor(tint, shade);
      for (let i = 0; i < 4; i++) { colors[i] = c; lights[i] = l; }
    }
    const slot = this.spriteSlot[q.sprite];
    // Greedy merge candidate: full boundary face of an unrotated cube with uniform vertex values.
    if (canGreedy && q.fullFace && layer !== 2 && colors[0] === colors[1] && colors[1] === colors[2] && colors[2] === colors[3]
      && lights[0] === lights[1] && lights[1] === lights[2] && lights[2] === lights[3]) {
      const ax = d < 2 ? 1 : d < 4 ? 2 : 0;
      const slice = [x, y, z][ax] - [x & ~15, y & ~15, z & ~15][ax];
      const ua = ax === 0 ? 1 : 0, va = ax === 2 ? 1 : 2;
      const key = `${layer}|${slice}|${slot}|${colors[0]}|${lights[0]}|${Array.from(q.uv).join(',')}`;
      let cells = greedy[d].get(key);
      if (!cells) { cells = []; greedy[d].set(key, cells); }
      const lp = [bx, by, bz];
      cells.push({ u: Math.round(lp[ua]), v: Math.round(lp[va]), q, layer, slot, color: colors[0], light: lights[0], base: lp });
      return;
    }
    this.writeQuad(layer, q, bx, by, bz, slot, colors, lights);
  }

  private writeQuad(layer: number, q: BakedQuad, bx: number, by: number, bz: number, slot: number, colors: number[], lights: number[]): void {
    const b = this.buf[layer];
    b.ensure();
    const o = b.n * 32;
    for (let i = 0; i < 4; i++) {
      b.vertex(o + i * 8, bx + q.pos[i * 3], by + q.pos[i * 3 + 1], bz + q.pos[i * 3 + 2], q.uv[i * 2], q.uv[i * 2 + 1], slot, colors[i], lights[i]);
    }
    if (layer === 2) b.centers.push(bx + (q.pos[0] + q.pos[6]) / 2, by + (q.pos[1] + q.pos[7]) / 2, bz + (q.pos[2] + q.pos[8]) / 2);
    b.n++;
  }

  private flushGreedy(d: number, cells: GreedyCell[]): void {
    const grid = new Int32Array(256).fill(-1);
    cells.forEach((c, i) => { grid[c.v * 16 + c.u] = i; });
    const used = new Uint8Array(256);
    const ax = d < 2 ? 1 : d < 4 ? 2 : 0;
    const ua = ax === 0 ? 1 : 0, va = ax === 2 ? 1 : 2;
    for (let v = 0; v < 16; v++) for (let u = 0; u < 16; u++) {
      const i = grid[v * 16 + u];
      if (i < 0 || used[v * 16 + u]) continue;
      let w = 1;
      while (u + w < 16 && grid[v * 16 + u + w] >= 0 && !used[v * 16 + u + w]) w++;
      let h = 1;
      outer: while (v + h < 16) {
        for (let k = 0; k < w; k++) if (grid[(v + h) * 16 + u + k] < 0 || used[(v + h) * 16 + u + k]) break outer;
        h++;
      }
      for (let dv = 0; dv < h; dv++) for (let du = 0; du < w; du++) used[(v + dv) * 16 + u + du] = 1;
      const c = cells[i];
      const b = this.buf[c.layer];
      b.ensure();
      const o = b.n * 32;
      for (let k = 0; k < 4; k++) {
        const p = [c.q.pos[k * 3], c.q.pos[k * 3 + 1], c.q.pos[k * 3 + 2]];
        // stretch vertex along the merged axes; UV extrapolates linearly so REPEAT tiles the sprite
        const su = p[ua] > 0.5 ? w : 0, sv = p[va] > 0.5 ? h : 0;
        const uvBase = [c.q.uv[k * 2], c.q.uv[k * 2 + 1]];
        // derivative of uv along ua/va from the unit quad
        const [duU, duV, dvU, dvV] = uvAxes(c.q, ua, va);
        const ext = [su - (p[ua] > 0.5 ? 1 : 0), sv - (p[va] > 0.5 ? 1 : 0)];
        p[ua] = su; p[va] = sv;
        const world = [c.base[0], c.base[1], c.base[2]];
        world[ua] = 0; world[va] = 0;
        const uu = uvBase[0] + duU * ext[0] + dvU * ext[1];
        const vv = uvBase[1] + duV * ext[0] + dvV * ext[1];
        const pu = [0, 0, 0]; pu[ua] = u; pu[va] = v;
        b.vertex(o + k * 8, world[0] + pu[0] + p[0], world[1] + pu[1] + p[1], world[2] + pu[2] + p[2], uu, vv, c.slot, c.color, c.light);
      }
      b.n++;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Liquids (LiquidBlockRenderer)
  // ---------------------------------------------------------------------------------------------
  private fluidHeight(src: MeshSource, type: number, x: number, y: number, z: number): number {
    const s = src.getState(x, y, z);
    if (this.info.fluid[s] === type) {
      const above = src.getState(x, y + 1, z);
      if (this.info.fluid[above] === type) return 1;
      return (this.info.fluidLevel[s] & 15) / 9;
    }
    return this.info.solidRender[s] || (this.info.layer[s] !== 3 && this.info.faceMask[s * 6] !== 0) ? -1 : 0;
  }

  private cornerHeight(src: MeshSource, type: number, h0: number, hA: number, hB: number, x: number, y: number, z: number): number {
    if (hA >= 1 || hB >= 1) return 1;
    const fs = [0, 0];
    const add = (h: number) => { if (h >= 0.8) { fs[0] += h * 10; fs[1] += 10; } else if (h >= 0) { fs[0] += h; fs[1] += 1; } };
    if (hA > 0 || hB > 0) {
      const hd = this.fluidHeight(src, type, x, y, z);
      if (hd >= 1) return 1;
      add(hd);
    }
    add(h0); add(hA); add(hB);
    return fs[1] === 0 ? 0 : fs[0] / fs[1];
  }

  /** FlowingFluid.getFlow: horizontal flow vector from neighbour heights. */
  private flow(src: MeshSource, type: number, x: number, y: number, z: number, own: number): [number, number] {
    const info = this.info;
    const ownH = own / 9;
    const fluidH = (st: number) => (info.fluid[st] === type ? (info.fluidLevel[st] & 15) / 9 : 0);
    const affects = (st: number) => info.fluid[st] === 0 || info.fluid[st] === type;
    let fx = 0, fz = 0;
    for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const ns = src.getState(x + dx, y, z + dz);
      if (!affects(ns)) continue;
      let f = fluidH(ns); let g = 0;
      if (f === 0) {
        if (!info.solidRender[ns]) {
          const bs = src.getState(x + dx, y - 1, z + dz);
          if (affects(bs)) { f = fluidH(bs); if (f > 0) g = ownH - (f - 0.8888889); }
        }
      } else if (f > 0) g = ownH - f;
      if (g !== 0) { fx += dx * g; fz += dz * g; }
    }
    const len = Math.hypot(fx, fz);
    return len > 0 ? [fx / len, fz / len] : [0, 0];
  }

  private liquid(src: MeshSource, s: number, x: number, y: number, z: number, ox: number, oy: number, oz: number): void {
    const info = this.info;
    const type = info.fluid[s];
    const water = type === 1;
    const still = water ? this.waterStill : this.lavaStill, flowS = water ? this.waterFlow : this.lavaFlow;
    const tint = water ? this.tintColor(src, this.reg.defaultState('water'), 0, x, y, z) : 0xffffff;
    const layer = water ? 2 : 0;
    const same = (dx: number, dy: number, dz: number) => info.fluid[src.getState(x + dx, y + dy, z + dz)] === type;
    const occluded = (dx: number, dy: number, dz: number, dir: number) => {
      const n = src.getState(x + dx, y + dy, z + dz);
      return info.faceMask[n * 6 + (dir ^ 1)] === 1;
    };
    const lightAt = () => {
      const a = this.light(src, x, y, z), b = this.light(src, x, y + 1, z);
      return Math.max(a & 255, b & 255) | Math.max(a & 0xff00, b & 0xff00);
    };
    const light = lightAt();
    const renderUp = !same(0, 1, 0);
    const renderDown = !same(0, -1, 0) && !occluded(0, -1, 0, 0);
    const own = info.fluidLevel[s] & 15;
    let hNW = 1, hNE = 1, hSE = 1, hSW = 1;
    if (renderUp || !same(0, 0, -1) || !same(0, 0, 1) || !same(-1, 0, 0) || !same(1, 0, 0)) {
      const h0 = this.fluidHeight(src, type, x, y, z);
      if (h0 < 1) {
        const hN = this.fluidHeight(src, type, x, y, z - 1), hS = this.fluidHeight(src, type, x, y, z + 1);
        const hE = this.fluidHeight(src, type, x + 1, y, z), hW = this.fluidHeight(src, type, x - 1, y, z);
        hNE = this.cornerHeight(src, type, h0, hN, hE, x + 1, y, z - 1);
        hNW = this.cornerHeight(src, type, h0, hN, hW, x - 1, y, z - 1);
        hSE = this.cornerHeight(src, type, h0, hS, hE, x + 1, y, z + 1);
        hSW = this.cornerHeight(src, type, h0, hS, hW, x - 1, y, z + 1);
      }
    }
    const lx = x - ox, ly = y - oy, lz = z - oz;
    const b = this.buf[layer];
    const push = (verts: number[][], sprite: number, shade: number) => {
      b.ensure();
      const o = b.n * 32;
      const c = packColor(tint, shade);
      const slot = this.spriteSlot[sprite];
      for (let i = 0; i < 4; i++) { const v = verts[i]; b.vertex(o + i * 8, lx + v[0], ly + v[1], lz + v[2], v[3], v[4], slot, c, light); }
      if (layer === 2) b.centers.push(lx + 0.5, ly + (verts[0][1] + verts[2][1]) / 2, lz + 0.5);
      b.n++;
    };
    const eps = 0.001;
    if (renderUp && !occluded(0, 1, 0, 1)) {
      const nw = hNW - eps, sw = hSW - eps, se = hSE - eps, ne = hNE - eps;
      const [fx, fz] = this.flow(src, type, x, y, z, own);
      let uv: number[][];
      let spr = still;
      if (fx === 0 && fz === 0) {
        uv = [[0, 0], [0, 1], [1, 1], [1, 0]];
      } else {
        spr = flowS;
        const ang = Math.atan2(fz, fx) - Math.PI / 2;
        const sn = Math.sin(ang) * 0.25, cs = Math.cos(ang) * 0.25;
        uv = [[0.5 + (-cs - sn), 0.5 + (-cs + sn)], [0.5 + (-cs + sn), 0.5 + (cs + sn)], [0.5 + (cs + sn), 0.5 + (cs - sn)], [0.5 + (cs - sn), 0.5 + (-cs - sn)]];
      }
      const top = [[0, nw, 0, ...uv[0]], [0, sw, 1, ...uv[1]], [1, se, 1, ...uv[2]], [1, ne, 0, ...uv[3]]];
      push(top, spr, SHADE[1]);
      // backward up face, visible from inside the liquid
      push([top[3], top[2], top[1], top[0]], spr, SHADE[1]);
    }
    if (renderDown) {
      const bottom = [[0, eps, 1, 0, 1], [0, eps, 0, 0, 0], [1, eps, 0, 1, 0], [1, eps, 1, 1, 1]];
      push(bottom, still, SHADE[0]);
    }
    const sides: [number, number, number, number, number, number, number, number, number, number][] = [
      // dir, dx, dz, x0,z0, x1,z1, hA(at x0z0), hB(at x1z1)
      [2, 0, -1, 1, 0, 0, 0, hNE, hNW, 0],
      [3, 0, 1, 0, 1, 1, 1, hSW, hSE, 0],
      [4, -1, 0, 0, 0, 0, 1, hNW, hSW, 0],
      [5, 1, 0, 1, 1, 1, 0, hSE, hNE, 0],
    ];
    for (const [dir, dx, dz, x0, z0, x1, z1, ha, hb] of sides) {
      if (same(dx, 0, dz) || occluded(dx, 0, dz, dir)) continue;
      const ns = src.getState(x + dx, y, z + dz);
      const nb = this.reg.name(ns);
      const overlay = water && (/(_leaves|glass|^ice|slime_block|honey_block)/.test(nb));
      const spr = overlay ? this.waterOverlay : flowS;
      const ex = dx * eps * -1, ez = dz * eps * -1;
      const u0 = 0, u1 = 0.5;
      const va = (1 - ha) * 0.5, vb = (1 - hb) * 0.5, vbot = 0.5;
      const verts = [
        [x0 + ex, ha, z0 + ez, u0, va], [x0 + ex, 0, z0 + ez, u0, vbot], [x1 + ex, 0, z1 + ez, u1, vbot], [x1 + ex, hb, z1 + ez, u1, vb],
      ];
      const sh = SHADE[dir];
      push(verts, spr, sh);
      if (!overlay) push([verts[3], verts[2], verts[1], verts[0]], spr, sh);
    }
  }
}

interface GreedyCell { u: number; v: number; q: BakedQuad; layer: number; slot: number; color: number; light: number; base: number[] }

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** vanilla AmbientOcclusionFace.blend: zero samples take the centre value; channel-wise mean. */
function blendLight(a: number, b: number, c: number, center: number): number {
  if (a === 0) a = center; if (b === 0) b = center; if (c === 0) c = center;
  const bl = ((a & 255) + (b & 255) + (c & 255) + (center & 255)) >> 2;
  const sk = ((a >> 8) + (b >> 8) + (c >> 8) + (center >> 8)) >> 2;
  return bl | (sk << 8);
}

/** d(uv)/d(axis) for a unit quad: returns [du/dua, dv/dua, du/dva, dv/dva]. */
function uvAxes(q: BakedQuad, ua: number, va: number): [number, number, number, number] {
  // find two edges from vertex 0
  const p = (i: number) => [q.pos[i * 3], q.pos[i * 3 + 1], q.pos[i * 3 + 2]];
  const t = (i: number) => [q.uv[i * 2], q.uv[i * 2 + 1]];
  let duU = 0, duV = 0, dvU = 0, dvV = 0;
  for (let i = 1; i < 4; i++) {
    const a = p(0), b = p(i);
    const da = b[ua] - a[ua], db = b[va] - a[va];
    const ta = t(0), tb = t(i);
    if (Math.abs(da) > 0.5 && Math.abs(db) < 0.5) { duU = (tb[0] - ta[0]) / da; duV = (tb[1] - ta[1]) / da; }
    if (Math.abs(db) > 0.5 && Math.abs(da) < 0.5) { dvU = (tb[0] - ta[0]) / db; dvV = (tb[1] - ta[1]) / db; }
  }
  return [duU, duV, dvU, dvV];
}
