// Structures: structure_set placement (random_spread / concentric_rings), structure starts, and
// pieces. Jigsaw structures (villages, outposts, trail ruins, ancient cities, trial chambers, camps)
// are assembled from the vanilla template pools + .nbt templates; template structures (ruined portals,
// shipwrecks, igloos, ocean ruins) place their vanilla templates; mineshafts and strongholds are
// built procedurally as in MineshaftPieces / StrongholdPieces (simplified, see DEVIATIONS.md).
import { JavaRandom } from '../util/javarandom';
import { readNbt } from './nbt';
import type { GenAccess } from './features';
import type { WorldGenerator, ProtoChunk } from './generator';
import type { RandomSource } from './random';

type Box = [number, number, number, number, number, number]; // inclusive min/max
const intersects = (a: Box, b: Box) => a[0] <= b[3] && a[3] >= b[0] && a[1] <= b[4] && a[4] >= b[1] && a[2] <= b[5] && a[5] >= b[2];
const inside = (a: Box, b: Box) => a[0] >= b[0] && a[3] <= b[3] && a[1] >= b[1] && a[4] <= b[4] && a[2] >= b[2] && a[5] <= b[5];

const STEP: Record<string, number> = { raw_generation: 0, lakes: 1, local_modifications: 2, underground_structures: 3, surface_structures: 4, strongholds: 5, underground_ores: 6, underground_decoration: 7, fluid_springs: 8, vegetal_decoration: 9, top_layer_modification: 10 };

interface Template { size: [number, number, number]; blocks: { x: number; y: number; z: number; s: number; jig?: Jigsaw }[] }
interface Jigsaw { name: string; target: string; pool: string; final: string; joint: string; front: string; top: string }

interface Piece {
  box: Box;
  place(g: GenAccess, clip: Box, gen: WorldGenerator): void;
}
interface Start { pieces: Piece[]; step: number; name?: string }

const ROT_DIRS = ['north', 'east', 'south', 'west'];
const rotDir = (d: string, rot: number) => { const i = ROT_DIRS.indexOf(d); return i < 0 ? d : ROT_DIRS[(i + rot) & 3]; };

export class StructureManager {
  private templates = new Map<string, Template | null>();
  private starts = new Map<string, Start | null>();
  private sets: { name: string; placement: any; structures: { structure: string; weight: number }[] }[] = [];
  private strongholdChunks: [number, number][] | null = null;

  constructor(readonly gen: WorldGenerator, readonly files: (path: string) => Uint8Array | null) {
    for (const k of Object.keys(gen.worldgen)) if (k.startsWith('structure_set/')) {
      const s = gen.worldgen[k];
      const dims = ['nether_complexes', 'nether_fossils', 'end_cities'];
      if (dims.includes(k.slice(14))) continue;
      this.sets.push({ name: k.slice(14), placement: s.placement, structures: s.structures });
    }
  }

  private get reg() { return this.gen.reg; }

  // ------------------------------------------------------------------ placement
  private largeSalt(r: JavaRandom, x: number, z: number, salt: number): void {
    r.setSeed(BigInt.asIntN(64, BigInt(x) * 341873128712n + BigInt(z) * 132897987541n + this.gen.opts.seed + BigInt(salt)));
  }
  private potentialChunk(p: any, cx: number, cz: number): [number, number] {
    const sp = p.spacing, sep = p.separation;
    const i = Math.floor(cx / sp), j = Math.floor(cz / sp);
    const r = new JavaRandom(0);
    this.largeSalt(r, i, j, p.salt);
    const k = sp - sep;
    const tri = p.spread_type === 'triangular';
    const l = tri ? (r.nextInt(k) + r.nextInt(k)) >> 1 : r.nextInt(k);
    const m = tri ? (r.nextInt(k) + r.nextInt(k)) >> 1 : r.nextInt(k);
    return [i * sp + l, j * sp + m];
  }
  private frequencyOk(p: any, cx: number, cz: number): boolean {
    const f = p.frequency ?? 1;
    if (f >= 1) return true;
    const r = new JavaRandom(0);
    const m = p.frequency_reduction_method ?? 'default';
    if (m === 'legacy_type_3') {
      r.setSeed(this.gen.opts.seed);
      const a = r.nextLong(), b = r.nextLong();
      r.setSeed(BigInt.asIntN(64, (BigInt(cx) * a) ^ (BigInt(cz) * b) ^ this.gen.opts.seed));
      return r.nextDouble() < f;
    }
    this.largeSalt(r, cx, cz, p.salt);
    return r.nextFloat() < f;
  }
  private isStart(p: any, cx: number, cz: number): boolean {
    const t = String(p.type).replace('minecraft:', '');
    if (t === 'random_spread') {
      const [sx, sz] = this.potentialChunk(p, cx, cz);
      return sx === cx && sz === cz && this.frequencyOk(p, cx, cz);
    }
    if (t === 'concentric_rings') return this.strongholds(p).some(([x, z]) => x === cx && z === cz);
    return false;
  }
  /** ChunkGeneratorStructureState.generateRingPositions (biome preference not applied, see DEVIATIONS). */
  private strongholds(p: any): [number, number][] {
    if (this.strongholdChunks) return this.strongholdChunks;
    const out: [number, number][] = [];
    const r = new JavaRandom(this.gen.opts.seed);
    let ang = r.nextDouble() * Math.PI * 2;
    let ring = 0, inRing = 0, perRing = p.spread;
    for (let k = 0; k < p.count; k++) {
      const d = 4 * p.distance + p.distance * ring * 6 + (r.nextDouble() - 0.5) * (p.distance * 2.5);
      out.push([Math.round(Math.cos(ang) * d), Math.round(Math.sin(ang) * d)]);
      ang += (Math.PI * 2) / perRing;
      if (++inRing === perRing) { ring++; inRing = 0; perRing += (2 * perRing) / (ring + 1); perRing = Math.min(perRing, p.count - k); ang += r.nextDouble() * Math.PI * 2; }
    }
    return (this.strongholdChunks = out);
  }

  /** Place the pieces of every structure intersecting the centre chunk for this decoration step. */
  place(center: ProtoChunk, g: GenAccess, step: number): void {
    if (!this.gen.opts.structures && this.gen.opts.type !== 'flat') return;
    const clip: Box = [center.cx * 16, -64, center.cz * 16, center.cx * 16 + 15, 319, center.cz * 16 + 15];
    const R = 8;
    for (const set of this.sets) {
      if (this.gen.opts.type === 'flat' && set.name !== 'villages') continue;
      for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
        const cx = center.cx + dx, cz = center.cz + dz;
        if (!this.isStart(set.placement, cx, cz)) continue;
        const st = this.start(set, cx, cz);
        if (!st || st.step !== step) continue;
        for (const p of st.pieces) if (intersects(p.box, clip)) p.place(g, clip, this.gen);
      }
    }
  }

  private start(set: (typeof this.sets)[number], cx: number, cz: number): Start | null {
    const key = set.name + ':' + cx + ',' + cz;
    if (this.starts.has(key)) return this.starts.get(key)!;
    let result: Start | null = null;
    // pick structure (weighted) and check biome at the start column
    const r = new JavaRandom(0);
    this.largeSalt(r, cx, cz, 0);
    let total = 0; for (const s of set.structures) total += s.weight;
    let pick = set.structures.length > 1 ? r.nextInt(total) : 0;
    let chosen = set.structures[0];
    for (const s of set.structures) { pick -= s.weight; if (pick < 0) { chosen = s; break; } }
    const candidates = set.structures.length > 1 ? [chosen, ...set.structures.filter((s) => s !== chosen)] : [chosen];
    for (const c of candidates) {
      const def = this.gen.worldgen['structure/' + c.structure.replace('minecraft:', '')];
      if (!def) continue;
      const x = cx * 16 + 8, z = cz * 16 + 8;
      const surf = this.surfaceY(x, z);
      const biome = this.gen.biomeAt(x >> 2, surf >> 2, z >> 2);
      const allowed = this.biomeTag(def.biomes);
      if (this.gen.opts.type !== 'flat' && !allowed.has(this.gen.biomes.list[biome].name)) continue;
      const rr = new JavaRandom(0);
      this.largeSalt(rr, cx, cz, 0);
      result = this.generate(def, c.structure.replace('minecraft:', ''), rr, cx, cz);
      if (result) { result.name = c.structure.replace('minecraft:', ''); break; }
    }
    this.starts.set(key, result);
    return result;
  }

  private biomeTag(ref: string | string[]): Set<string> {
    const out = new Set<string>();
    const tags = this.gen.tags.tags as any;
    const add = (v: string) => {
      if (v.startsWith('#')) { const t = tags['worldgen/biome/' + v.slice(1).replace('minecraft:', '')]; if (t) for (const x of t.values) add(typeof x === 'string' ? x : x.id); }
      else out.add(v.replace('minecraft:', ''));
    };
    for (const v of Array.isArray(ref) ? ref : [ref]) add(v);
    return out;
  }

  /** Terrain height (WORLD_SURFACE_WG) at a column straight from the noise router. */
  surfaceY(x: number, z: number): number {
    const fd = (this.gen as any).finalDensity;
    for (let y = 319; y > -64; y -= 4) if (fd(x, y, z) > 0) { let yy = y; while (yy < 319 && fd(x, yy + 1, z) > 0) yy++; return yy + 1; }
    return 63;
  }

  // ------------------------------------------------------------------ generation
  private generate(def: any, _name: string, r: JavaRandom, cx: number, cz: number): Start | null {
    const t = String(def.type).replace('minecraft:', '');
    const step = STEP[def.step] ?? 4;
    switch (t) {
      case 'jigsaw': return this.jigsaw(def, r, cx, cz, step);
      case 'ruined_portal': return this.ruinedPortal(def, r, cx, cz, step);
      case 'shipwreck': return this.single(['shipwreck/' + ['with_mast', 'upsidedown_full', 'sideways_full', 'rightsideup_full', 'with_mast_degraded'][r.nextInt(5)]], r, cx, cz, step, def.is_beached ? 'surface' : 'ocean');
      case 'igloo': return this.single(['igloo/top'], r, cx, cz, step, 'surface');
      case 'ocean_ruin': return this.single([`underwater_ruin/${def.biome_temp === 'warm' ? 'warm' : 'brick'}_${1 + r.nextInt(8)}`], r, cx, cz, step, 'ocean');
      case 'buried_treasure': return this.buriedTreasure(cx, cz, step);
      case 'mineshaft': return this.mineshaft(def, r, cx, cz, step);
      case 'stronghold': return this.stronghold(r, cx, cz, step);
      default: return null; // desert_pyramid, jungle_temple, swamp_hut, monument, mansion: DEVIATIONS.md
    }
  }

  template(loc: string): Template | null {
    loc = loc.replace('minecraft:', '');
    if (this.templates.has(loc)) return this.templates.get(loc)!;
    const bytes = this.files(loc + '.nbt');
    if (!bytes) { this.templates.set(loc, null); return null; }
    const n = readNbt(bytes) as any;
    const palette: any[] = n.palette ?? (n.palettes ? n.palettes[0] : []);
    const states = palette.map((p: any) => {
      // 26.3 templates use {id, properties}; older ones {Name, Properties}
      const name = String(p.id ?? p.Name).replace('minecraft:', '');
      try { return this.reg.state(name, Object.fromEntries(Object.entries(p.properties ?? p.Properties ?? {}).filter(([k]) => { try { return this.reg.hasProp(this.reg.defaultState(name), k); } catch { return false; } }).map(([k, v]) => [k, String(v)]))); } catch { return -1; }
    });
    const blocks: Template['blocks'] = [];
    for (const b of n.blocks as any[]) {
      const s = states[b.state];
      if (s === undefined || s < 0) continue;
      const pos = b.pos as number[];
      const e: Template['blocks'][number] = { x: pos[0], y: pos[1], z: pos[2], s };
      if (this.reg.name(s) === 'jigsaw' && b.nbt) {
        const o = String(this.reg.prop(s, 'orientation') ?? 'north_up').split('_');
        e.jig = { name: String(b.nbt.name), target: String(b.nbt.target), pool: String(b.nbt.pool), final: String(b.nbt.final_state ?? 'minecraft:air'), joint: String(b.nbt.joint ?? 'rollable'), front: o[0], top: o[1] };
      }
      blocks.push(e);
    }
    const t: Template = { size: n.size as [number, number, number], blocks };
    this.templates.set(loc, t);
    return t;
  }

  /** Block state rotated clockwise `rot` quarter turns (Rotation.CLOCKWISE_90 per step). */
  rotate(s: number, rot: number): number {
    if (!rot) return s;
    const reg = this.reg;
    const props = reg.props(s);
    let out = s;
    const set = (k: string, v: string) => { try { out = reg.withProp(out, k, v); } catch { /* value not valid */ } };
    if (props.facing) set('facing', rotDir(props.facing, rot));
    if (props.axis && rot & 1 && props.axis !== 'y') set('axis', props.axis === 'x' ? 'z' : 'x');
    if (props.rotation) set('rotation', String((+props.rotation + rot * 4) & 15));
    if (props.north !== undefined && props.east !== undefined && props.south !== undefined && props.west !== undefined) {
      const v = [props.north, props.east, props.south, props.west];
      for (let i = 0; i < 4; i++) set(ROT_DIRS[(i + rot) & 3], v[i]);
    }
    if (props.shape && /^(north_south|east_west|ascending_|south_|north_)/.test(props.shape)) {
      const sh = props.shape;
      const rotRail = (x: string) => {
        if (x === 'north_south') return rot & 1 ? 'east_west' : x;
        if (x === 'east_west') return rot & 1 ? 'north_south' : x;
        if (x.startsWith('ascending_')) return 'ascending_' + rotDir(x.slice(10), rot);
        const [a, b] = x.split('_'); const ra = rotDir(a, rot), rb = rotDir(b, rot);
        const ns = [ra, rb].find((d) => d === 'north' || d === 'south'), ew = [ra, rb].find((d) => d === 'east' || d === 'west');
        return ns && ew ? ns + '_' + ew : x;
      };
      set('shape', rotRail(sh));
    }
    if (props.orientation) { const [f, tp] = props.orientation.split('_'); set('orientation', rotDir(f, rot) + '_' + rotDir(tp, rot)); }
    return out;
  }

  private rotPos(x: number, z: number, rot: number, size: [number, number, number]): [number, number] {
    switch (rot & 3) {
      case 1: return [size[2] - 1 - z, x];
      case 2: return [size[0] - 1 - x, size[2] - 1 - z];
      case 3: return [z, size[0] - 1 - x];
      default: return [x, z];
    }
  }

  private processors(ref: any): any[] {
    if (!ref) return [];
    if (typeof ref === 'string') return this.gen.worldgen['processor_list/' + ref.replace('minecraft:', '')]?.processors ?? [];
    return ref.processors ?? [];
  }

  private applyProcessors(procs: any[], s: number, cur: number, x: number, y: number, z: number): number {
    for (const p of procs) {
      const t = String(p.processor_type).replace('minecraft:', '');
      const r = new JavaRandom(BigInt(Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)));
      if (t === 'block_rot') {
        const rot = p.rottable_blocks ? this.gen.tags.has(String(p.rottable_blocks), s) : true;
        if (rot && r.nextFloat() > p.integrity) return -1;
      } else if (t === 'protected_blocks') {
        if (this.gen.tags.has(String(p.value), cur)) return -1;
      } else if (t === 'rule' || t === 'capped') {
        const rules = t === 'rule' ? p.rules : p.delegate?.rules ?? [];
        for (const rl of rules) {
          if (this.ruleMatch(rl.input_predicate, s, r) && this.ruleMatch(rl.location_predicate, cur, r)) { s = this.gen.engine.stateOf(rl.output_state); break; }
        }
      }
    }
    return s;
  }
  private ruleMatch(pr: any, s: number, r: JavaRandom): boolean {
    if (!pr) return true;
    const t = String(pr.predicate_type).replace('minecraft:', '');
    switch (t) {
      case 'always_true': return true;
      case 'block_match': return this.reg.name(s) === pr.block.replace('minecraft:', '');
      case 'random_block_match': return this.reg.name(s) === pr.block.replace('minecraft:', '') && r.nextFloat() < pr.probability;
      case 'tag_match': return this.gen.tags.has(pr.tag, s);
      case 'random_blockstate_match': return s === this.gen.engine.stateOf(pr.block_state) && r.nextFloat() < pr.probability;
      case 'blockstate_match': return s === this.gen.engine.stateOf(pr.block_state);
      default: return false;
    }
  }

  /** A template piece. terrain_matching follows WORLD_SURFACE_WG per column (GravityProcessor offset -1). */
  private templatePiece(tpl: Template, ox: number, oy: number, oz: number, rot: number, procs: any[], terrain: boolean): Piece {
    const [sx0, sz0] = rot & 1 ? [tpl.size[2], tpl.size[0]] : [tpl.size[0], tpl.size[2]];
    const box: Box = [ox, oy, oz, ox + sx0 - 1, oy + tpl.size[1] - 1, oz + sz0 - 1];
    return {
      box,
      place: (g, clip) => {
        for (const b of tpl.blocks) {
          const [rx, rz] = this.rotPos(b.x, b.z, rot, tpl.size);
          const x = ox + rx, z = oz + rz;
          if (x < clip[0] || x > clip[3] || z < clip[2] || z > clip[5]) continue;
          const y = terrain ? g.height('WORLD_SURFACE_WG', x, z) - 1 + b.y : oy + b.y;
          let s = b.jig ? this.reg.state(b.jig.final.replace('minecraft:', '').split('[')[0]) : this.rotate(b.s, rot);
          const name = this.reg.name(s);
          if (name === 'structure_void') continue;
          if (name === 'jigsaw' || name === 'structure_block') s = 0;
          s = this.applyProcessors(procs, s, g.get(x, y, z), x, y, z);
          if (s < 0) continue;
          g.set(x, y, z, s);
        }
      },
    };
  }

  // ------------------------------------------------------------------ jigsaw
  private pool(name: string): any { return this.gen.worldgen['template_pool/' + name.replace('minecraft:', '')]; }

  private shuffledElements(pool: any, r: RandomSource | JavaRandom): any[] {
    const list: any[] = [];
    for (const e of pool.elements) for (let i = 0; i < e.weight; i++) list.push(e.element);
    for (let i = list.length - 1; i > 0; i--) { const j = r.nextInt(i + 1); [list[i], list[j]] = [list[j], list[i]]; }
    return list;
  }

  private elementTemplates(el: any): { tpl: Template; procs: any[]; terrain: boolean }[] {
    const t = String(el.element_type).replace('minecraft:', '');
    if (t === 'single_pool_element' || t === 'legacy_single_pool_element') {
      const tpl = this.template(el.location);
      return tpl ? [{ tpl, procs: this.processors(el.processors), terrain: el.projection === 'terrain_matching' }] : [];
    }
    if (t === 'list_pool_element') return el.elements.flatMap((e: any) => this.elementTemplates(e));
    return [];
  }

  private jigsaw(def: any, r: JavaRandom, cx: number, cz: number, step: number): Start | null {
    const startPool = this.pool(def.start_pool);
    if (!startPool) return null;
    const startEl = this.shuffledElements(startPool, r)[0];
    const parts = this.elementTemplates(startEl);
    if (!parts.length) return null;
    const rot = r.nextInt(4);
    const x0 = cx * 16, z0 = cz * 16;
    const surf = def.project_start_to_heightmap ? this.surfaceY(x0, z0) : 0;
    const y0 = surf + (def.start_height?.absolute ?? 0);
    const maxDist = def.max_distance_from_center ?? 80;
    const depthMax = def.size ?? 6;
    const pieces: Piece[] = [];
    const boxes: Box[] = [];
    const queue: { tpl: Template; x: number; y: number; z: number; rot: number; depth: number; terrain: boolean; box: Box }[] = [];
    const addPiece = (tpl: Template, x: number, y: number, z: number, rt: number, procs: any[], terrain: boolean, depth: number) => {
      const p = this.templatePiece(tpl, x, y, z, rt, procs, terrain);
      pieces.push(p); boxes.push(p.box);
      queue.push({ tpl, x, y, z, rot: rt, depth, terrain, box: p.box });
    };
    for (const pt of parts) addPiece(pt.tpl, x0, y0, z0, rot, pt.procs, pt.terrain, 0);
    const limit: Box = [x0 - maxDist, -64, z0 - maxDist, x0 + maxDist, 319, z0 + maxDist];
    while (queue.length) {
      const cur = queue.shift()!;
      const jigs = cur.tpl.blocks.filter((b) => b.jig);
      for (const j of jigs) {
        const jg = j.jig!;
        const [rx, rz] = this.rotPos(j.x, j.z, cur.rot, cur.tpl.size);
        const front = jg.front === 'up' || jg.front === 'down' ? jg.front : rotDir(jg.front, cur.rot);
        const fv = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] }[front as 'north'];
        const px = cur.x + rx, py = cur.y + j.y, pz = cur.z + rz;
        const tx = px + fv[0], ty = py + fv[1], tz = pz + fv[2];
        let pool = this.pool(jg.pool);
        if (!pool) continue;
        if (cur.depth + 1 > depthMax) pool = this.pool(pool.fallback ?? 'minecraft:empty');
        if (!pool) continue;
        let placed = false;
        for (const el of this.shuffledElements(pool, r)) {
          if (placed) break;
          if (String(el.element_type).endsWith('empty_pool_element')) break;
          if (String(el.element_type).endsWith('feature_pool_element')) {
            const fname = el.feature;
            const fbox: Box = [tx, ty, tz, tx, ty, tz];
            pieces.push({ box: fbox, place: (g, clip, gen) => {
              if (tx < clip[0] || tx > clip[3] || tz < clip[2] || tz > clip[5]) return;
              const pf = gen.worldgen['placed_feature/' + String(fname).replace('minecraft:', '')];
              if (pf) gen.engine.placeFeature(pf, g, new JavaRandom(BigInt(tx * 31 + tz)) as unknown as RandomSource, tx, cur.terrain ? g.height('WORLD_SURFACE_WG', tx, tz) : ty, tz, '', false);
            } });
            placed = true; break;
          }
          const parts2 = this.elementTemplates(el);
          if (!parts2.length) continue;
          const tpl = parts2[0].tpl;
          const rots = [0, 1, 2, 3];
          for (let i = 3; i > 0; i--) { const k = r.nextInt(i + 1); [rots[i], rots[k]] = [rots[k], rots[i]]; }
          for (const crot of rots) {
            if (placed) break;
            for (const cj of tpl.blocks) {
              if (!cj.jig || cj.jig.name !== jg.target) continue;
              const cf = cj.jig.front === 'up' || cj.jig.front === 'down' ? cj.jig.front : rotDir(cj.jig.front, crot);
              const opp = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' }[front as 'north'];
              if (cf !== opp) continue;
              const [crx, crz] = this.rotPos(cj.x, cj.z, crot, tpl.size);
              const childTerrain = parts2[0].terrain;
              const nx = tx - crx, nz = tz - crz;
              let ny = ty - cj.y;
              if (cur.terrain || childTerrain) ny = childTerrain ? 0 : this.surfaceY(tx, tz) - cj.y;
              const [sx, sz] = crot & 1 ? [tpl.size[2], tpl.size[0]] : [tpl.size[0], tpl.size[2]];
              const nb: Box = [nx, ny, nz, nx + sx - 1, ny + tpl.size[1] - 1, nz + sz - 1];
              if (childTerrain) { nb[1] = ty - 8; nb[4] = ty + 8; }
              if (!inside(nb, limit)) continue;
              const inParent = inside([tx, ty, tz, tx, ty, tz], cur.box);
              const clash = boxes.some((b) => b !== cur.box && intersects(shrink(nb), shrink(b))) || (!inParent && intersects(shrink(nb), shrink(cur.box)));
              if (clash) continue;
              addPiece(tpl, nx, ny, nz, crot, parts2[0].procs, childTerrain, cur.depth + 1);
              placed = true; break;
            }
          }
        }
      }
    }
    return { pieces, step };
  }

  // ------------------------------------------------------------------ template structures
  private single(locs: string[], r: JavaRandom, cx: number, cz: number, step: number, mode: 'surface' | 'ocean'): Start | null {
    const tpl = this.template(locs[0]);
    if (!tpl) return null;
    const rot = r.nextInt(4);
    const x = cx * 16, z = cz * 16;
    let y = this.surfaceY(x, z);
    if (mode === 'ocean') y = Math.min(y, 63) - 1 - r.nextInt(3);
    return { pieces: [this.templatePiece(tpl, x, y, z, rot, [], false)], step };
  }

  private ruinedPortal(def: any, r: JavaRandom, cx: number, cz: number, step: number): Start | null {
    let total = 0; for (const s of def.setups) total += s.weight;
    let f = r.nextFloat() * total; let setup = def.setups[0];
    for (const s of def.setups) { f -= s.weight; if (f <= 0) { setup = s; break; } }
    const giant = r.nextFloat() < 0.05;
    const loc = giant ? `ruined_portal/giant_portal_${1 + r.nextInt(3)}` : `ruined_portal/portal_${1 + r.nextInt(10)}`;
    const tpl = this.template(loc);
    if (!tpl) return null;
    const rot = r.nextInt(4);
    const x = cx * 16, z = cz * 16;
    let y = this.surfaceY(x + 8, z + 8);
    if (setup.placement === 'underground') y = Math.max(-50, y - 15 - r.nextInt(Math.max(1, y + 40)));
    else if (setup.placement === 'in_mountain') y = y - r.nextInt(10);
    else y = y - 1;
    const procs = [
      { processor_type: 'minecraft:rule', rules: [
        { input_predicate: { predicate_type: 'minecraft:random_block_match', block: 'minecraft:obsidian', probability: 0.3 }, output_state: { Name: 'minecraft:crying_obsidian' } },
        { input_predicate: { predicate_type: 'minecraft:random_block_match', block: 'minecraft:stone_bricks', probability: setup.mossiness }, output_state: { Name: 'minecraft:mossy_stone_bricks' } },
        { input_predicate: { predicate_type: 'minecraft:random_block_match', block: 'minecraft:gold_block', probability: 0.3 }, output_state: { Name: 'minecraft:air' } },
      ] },
    ];
    return { pieces: [this.templatePiece(tpl, x, y, z, rot, procs, false)], step };
  }

  private buriedTreasure(cx: number, cz: number, step: number): Start {
    const x = cx * 16 + 9, z = cz * 16 + 9;
    return { step, pieces: [{ box: [x, -64, z, x, 319, z], place: (g, clip) => {
      if (x < clip[0] || x > clip[3] || z < clip[2] || z > clip[5]) return;
      let y = g.height('OCEAN_FLOOR_WG', x, z) - 1;
      while (y > -60 && !['sand', 'gravel', 'sandstone', 'stone', 'dirt'].includes(this.reg.name(g.get(x, y, z)))) y--;
      g.set(x, y - 1, z, this.reg.defaultState('chest'));
    } }] };
  }

  // ------------------------------------------------------------------ mineshaft
  private mineshaft(def: any, r: JavaRandom, cx: number, cz: number, step: number): Start {
    const mesa = def.mineshaft_type === 'mesa';
    const planks = this.reg.defaultState(mesa ? 'dark_oak_planks' : 'oak_planks');
    const fence = this.reg.defaultState(mesa ? 'dark_oak_fence' : 'oak_fence');
    const rail = this.reg.defaultState('rail'), web = this.reg.defaultState('cobweb');
    const pieces: Piece[] = []; const boxes: Box[] = [];
    const bx = cx * 16 + 2, bz = cz * 16 + 2;
    const y0 = mesa ? 50 + r.nextInt(20) : 10 + r.nextInt(40);
    const room: Box = [bx, y0, bz, bx + 7 + r.nextInt(6), y0 + 4 + r.nextInt(6), bz + 7 + r.nextInt(6)];
    const air = 0;
    const carve = (b: Box, floor: boolean) => ({ box: b, place: (g: GenAccess, clip: Box) => {
      for (let x = Math.max(b[0], clip[0]); x <= Math.min(b[3], clip[3]); x++) for (let z = Math.max(b[2], clip[2]); z <= Math.min(b[5], clip[5]); z++) for (let y = b[1]; y <= b[4]; y++) {
        const cur = g.get(x, y, z);
        if (cur === 0 || this.reg.name(cur) === 'water' || this.reg.name(cur) === 'lava') continue;
        g.set(x, y, z, floor && y === b[1] - 1 ? planks : air);
      }
    } });
    pieces.push(carve(room, false)); boxes.push(room);
    const corridor = (x: number, y: number, z: number, dir: number, depth: number) => {
      if (depth > 8) return;
      const len = (r.nextInt(3) + 2) * 5;
      const [dx, dz] = [[0, -1], [1, 0], [0, 1], [-1, 0]][dir];
      const x1 = x + dx * (len - 1), z1 = z + dz * (len - 1);
      const b: Box = [Math.min(x, x1) - (dz ? 1 : 0), y, Math.min(z, z1) - (dx ? 1 : 0), Math.max(x, x1) + (dz ? 1 : 0), y + 2, Math.max(z, z1) + (dx ? 1 : 0)];
      if (Math.abs(b[0] - bx) > 80 || Math.abs(b[2] - bz) > 80 || boxes.some((o) => intersects(shrink(o), shrink(b)))) return;
      boxes.push(b);
      const seed = r.nextLong();
      pieces.push({ box: b, place: (g, clip) => {
        const rr = new JavaRandom(seed);
        for (let i = 0; i < len; i++) {
          const px = x + dx * i, pz = z + dz * i;
          const support = i % 5 === 2;
          const rnd = rr.nextFloat(), webR = rr.nextFloat();
          for (let w = -1; w <= 1; w++) for (let h = 0; h <= 2; h++) {
            const qx = px + (dz ? w : 0), qz = pz + (dx ? w : 0), qy = y + h;
            if (qx < clip[0] || qx > clip[3] || qz < clip[2] || qz > clip[5]) continue;
            const cur = g.get(qx, qy, qz);
            if (this.reg.name(cur) === 'water' || this.reg.name(cur) === 'lava') continue;
            let s = air;
            if (support && w !== 0 && h < 2) s = fence;
            else if (support && h === 2) s = planks;
            else if (h === 0 && w === 0 && rnd < 0.7) s = rail;
            else if (h === 2 && webR < 0.08 && !support) s = web;
            if (s === rail && rail >= 0) { try { s = this.reg.withProp(rail, 'shape', dx ? 'east_west' : 'north_south'); } catch { /* */ } }
            g.set(qx, qy, qz, s);
          }
          if (pz >= clip[2] && pz <= clip[5] && px >= clip[0] && px <= clip[3] && !this.gen.engine.solid(g.get(px, y - 1, pz))) g.set(px, y - 1, pz, planks);
        }
      } });
      const ex = x + dx * len, ez = z + dz * len;
      const n = r.nextInt(4);
      if (n === 0) { corridor(ex, y, ez, (dir + 1) & 3, depth + 1); corridor(ex, y, ez, (dir + 3) & 3, depth + 1); }
      else if (n === 1) corridor(ex, y + (r.nextBoolean() ? 4 : -4) * 0, ez, dir, depth + 1);
      else corridor(ex, y, ez, (dir + (r.nextBoolean() ? 1 : 3)) & 3, depth + 1);
    };
    for (let d = 0; d < 4; d++) if (r.nextInt(2) === 0 || d === 0) {
      const mx = (room[0] + room[3]) >> 1, mz = (room[2] + room[5]) >> 1;
      const sx = d === 1 ? room[3] + 1 : d === 3 ? room[0] - 1 : mx, sz = d === 0 ? room[2] - 1 : d === 2 ? room[5] + 1 : mz;
      corridor(sx, y0, sz, d, 1);
    }
    return { pieces, step };
  }

  // ------------------------------------------------------------------ stronghold
  private stronghold(r: JavaRandom, cx: number, cz: number, step: number): Start {
    const S = (n: string) => this.reg.defaultState(n);
    const bricks = [S('stone_bricks'), S('mossy_stone_bricks'), S('cracked_stone_bricks')];
    const x0 = cx * 16 + 2, z0 = cz * 16 + 2;
    const surf = this.surfaceY(x0, z0);
    const yRoom = Math.max(-40, Math.min(surf - 40, 20 + r.nextInt(20)));
    const pieces: Piece[] = [];
    const seed = r.nextLong();
    const brickAt = (rr: JavaRandom) => { const f = rr.nextFloat(); return f < 0.2 ? bricks[2] : f < 0.5 ? bricks[1] : bricks[0]; };
    const shell = (b: Box) => ({ box: b, place: (g: GenAccess, clip: Box) => {
      const rr = new JavaRandom(seed ^ BigInt(b[0] * 31 + b[2]));
      for (let x = b[0]; x <= b[3]; x++) for (let y = b[1]; y <= b[4]; y++) for (let z = b[2]; z <= b[5]; z++) {
        const br = brickAt(rr);
        if (x < clip[0] || x > clip[3] || z < clip[2] || z > clip[5]) continue;
        const wall = x === b[0] || x === b[3] || y === b[1] || y === b[4] || z === b[2] || z === b[5];
        g.set(x, y, z, wall ? br : 0);
      }
    } });
    // spiral stairs down from near the surface to the corridor level
    const stairTop = Math.min(surf - 6, yRoom + 40);
    pieces.push(shell([x0, yRoom, z0, x0 + 4, stairTop, z0 + 4]));
    // corridors and portal room
    const corr: Box = [x0 + 5, yRoom, z0, x0 + 24, yRoom + 4, z0 + 4];
    pieces.push(shell(corr));
    const pr: Box = [x0 + 25, yRoom - 1, z0 - 3, x0 + 35, yRoom + 7, z0 + 13];
    pieces.push(shell(pr));
    // door openings
    pieces.push({ box: [x0 + 4, yRoom + 1, z0 + 1, x0 + 25, yRoom + 3, z0 + 3], place: (g, clip) => {
      for (let x = x0 + 4; x <= x0 + 25; x++) for (let y = yRoom + 1; y <= yRoom + 3; y++) for (let z = z0 + 1; z <= z0 + 3; z++)
        if (x >= clip[0] && x <= clip[3] && z >= clip[2] && z <= clip[5]) g.set(x, y, z, 0);
    } });
    // portal: 12 frames around a 3x3 hole over lava, each frame has an eye with 10% chance
    pieces.push({ box: [x0 + 28, yRoom, z0 + 3, x0 + 32, yRoom + 3, z0 + 7], place: (g, clip) => {
      const rr = new JavaRandom(seed);
      const put = (x: number, y: number, z: number, s: number) => { if (x >= clip[0] && x <= clip[3] && z >= clip[2] && z <= clip[5]) g.set(x, y, z, s); };
      const px = x0 + 29, pz = z0 + 4, py = yRoom + 1;
      for (let i = 0; i < 3; i++) {
        const eye = () => (rr.nextFloat() < 0.1 ? 'true' : 'false');
        put(px + i, py, pz - 1, this.reg.state('end_portal_frame', { facing: 'south', eye: eye() }));
        put(px + i, py, pz + 3, this.reg.state('end_portal_frame', { facing: 'north', eye: eye() }));
        put(px - 1, py, pz + i, this.reg.state('end_portal_frame', { facing: 'east', eye: eye() }));
        put(px + 3, py, pz + i, this.reg.state('end_portal_frame', { facing: 'west', eye: eye() }));
      }
      for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) put(px + i, py - 1, pz + k, S('lava'));
      put(px + 1, py, pz - 3, S('spawner'));
    } });
    return { pieces, step };
  }
}

const shrink = (b: Box): Box => [b[0] + 0.25, b[1] + 0.25, b[2] + 0.25, b[3] - 0.25, b[4] - 0.25, b[5] - 0.25];
