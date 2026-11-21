// NoiseBasedChunkGenerator for the overworld presets (normal / large_biomes / amplified / single biome)
// and FlatLevelSource (superflat). Pipeline per vanilla ChunkStatus order:
//   noise (+aquifer) -> biomes -> surface -> carvers -> features (needs 3x3 neighbourhood)
import { biomeTemperature } from '../world/climate';
import { DensityContext, type DF } from './density';
import { Xoroshiro, type PositionalRandomFactory } from './random';
import { overworldParameters, netherParameters, MultiNoiseBiomeSource } from './biomesource';
import { SurfaceSystem, NO_WATER, type SurfaceColumnCtx } from './surface';
import { Engine, Tags, type GenAccess } from './features';
import { applyCarvers, type CarveTarget } from './carvers';
import type { BlockRegistry } from '../world/registry';
import type { Biomes } from '../world/biomes';
import { StructureManager } from './structures';

export const MIN_Y = -64, HEIGHT = 384, MAX_Y = MIN_Y + HEIGHT, SEA_LEVEL = 63;
const IDX = (x: number, y: number, z: number) => ((y - MIN_Y) << 8) | (z << 4) | x;

export type WorldType = 'normal' | 'large_biomes' | 'amplified' | 'flat' | 'single_biome';
export type Dimension = 'overworld' | 'the_nether' | 'the_end';
export interface GenOptions { seed: bigint; type: WorldType; dimension?: Dimension; singleBiome?: string; structures: boolean; flatPreset?: string; bonusChest?: boolean }

export class ProtoChunk {
  readonly states = new Uint16Array(16 * 16 * HEIGHT);
  readonly biomes = new Uint8Array(4 * 4 * (HEIGHT / 4));
  decorated = false;
  constructor(readonly cx: number, readonly cz: number) {}
  get(x: number, y: number, z: number): number { return y < MIN_Y || y >= MAX_Y ? 0 : this.states[IDX(x, y, z)]; }
  set(x: number, y: number, z: number, s: number): void { if (y >= MIN_Y && y < MAX_Y) this.states[IDX(x, y, z)] = s; }
  biome(x: number, y: number, z: number): number {
    const qy = Math.max(0, Math.min(HEIGHT / 4 - 1, (y - MIN_Y) >> 2));
    return this.biomes[(qy << 4) | ((z >> 2) << 2) | (x >> 2)];
  }
}

export class WorldGenerator {
  readonly random: PositionalRandomFactory;
  readonly density: DensityContext;
  private finalDensity: DF; private prelimSurface: DF; private router: Record<string, DF> = {};
  private aq: Record<string, DF> = {};
  readonly biomeSource: MultiNoiseBiomeSource | null;
  readonly surface: SurfaceSystem;
  readonly engine: Engine;
  readonly tags: Tags;
  private surfaceNoise; private secondaryNoise;
  private noiseRandom: PositionalRandomFactory;
  private aquiferRandom: PositionalRandomFactory;
  private stepFeatures: string[][] = [];
  private biomeFeatureSets: Set<string>[] = [];
  private carvers = new Map<string, any>();
  private S: Record<string, number> = {};
  readonly structures: StructureManager;
  private flatLayers: number[] | null = null;
  private singleBiome = -1;

  constructor(readonly opts: GenOptions, readonly worldgen: Record<string, any>, tagsJson: Record<string, any>,
    readonly reg: BlockRegistry, readonly biomes: Biomes, structureFiles: (path: string) => Uint8Array | null) {
    this.random = Xoroshiro.fromSeed(opts.seed).forkPositional();
    this.density = new DensityContext(worldgen, this.random, opts.seed);
    this.dimension = opts.dimension ?? 'overworld';
    const settingsName = this.dimension === 'the_nether' ? 'nether' : this.dimension === 'the_end' ? 'end'
      : opts.type === 'large_biomes' ? 'large_biomes' : opts.type === 'amplified' ? 'amplified' : 'overworld';
    const ns = worldgen['noise_settings/' + settingsName];
    this.nMinY = ns.noise.min_y; this.nHeight = ns.noise.height; this.seaLevel = ns.sea_level;
    this.defaultBlock = reg.defaultState(String(ns.default_block.Name ?? ns.default_block.id ?? ns.default_block).replace('minecraft:', ''));
    const fl = String(ns.default_fluid.Name ?? ns.default_fluid.id ?? ns.default_fluid).replace('minecraft:', '');
    this.defaultFluid = fl === 'air' ? 0 : reg.state(fl, { level: '0' });
    const R = ns.noise_router;
    for (const k of Object.keys(R)) this.router[k] = this.density.compile(R[k]);
    this.finalDensity = this.router.final_density;
    for (const k of Object.keys(ns.aquifers ?? {})) this.aq[k] = this.density.compile(ns.aquifers[k]);
    this.hasAquifers = !!ns.aquifers;
    // aquifer surface_level is the preliminary surface; vanilla samples it through the 16-block
    // interpolated chunk_surface_level, which we use for per-column queries
    this.prelimSurface = this.router.chunk_surface_level ?? this.aq.surface_level;
    this.biomeSource = opts.type === 'single_biome' || opts.type === 'flat' || this.dimension === 'the_end' ? null
      : new MultiNoiseBiomeSource(this.dimension === 'the_nether' ? netherParameters() : overworldParameters(), (n) => biomes.id(n));
    if (opts.type === 'single_biome') this.singleBiome = biomes.id(opts.singleBiome ?? 'plains');
    this.tags = new Tags(tagsJson, reg);
    this.surface = new SurfaceSystem({
      worldgen, density: this.density, random: this.random, biomeId: (n) => biomes.id(n),
      state: (id, props) => reg.state(id.replace('minecraft:', ''), props ?? {}), minY: this.nMinY, height: this.nHeight,
    }, ns.material_rule);
    this.surfaceNoise = this.density.noise('surface');
    this.secondaryNoise = this.density.noise('surface_secondary');
    this.noiseRandom = this.random.fromHashOf('minecraft:surface').forkPositional();
    this.aquiferRandom = this.random.fromHashOf('minecraft:aquifer').forkPositional();
    for (const n of ['stone', 'water', 'lava', 'air', 'bedrock', 'grass_block', 'dirt', 'chest']) this.S[n] = reg.defaultState(n);
    this.S.water = reg.state('water', { level: '0' }); this.S.lava = reg.state('lava', { level: '0' });
    // Feature lists per generation step, ordered by first appearance across biomes in registry order.
    for (let step = 0; step < 11; step++) {
      const seen = new Set<string>(); const list: string[] = [];
      for (const b of biomes.list) for (const f of (worldgen['biome/' + b.name].features?.[step] ?? []) as string[]) if (!seen.has(f)) { seen.add(f); list.push(f); }
      this.stepFeatures.push(list);
    }
    for (const b of biomes.list) this.biomeFeatureSets.push(new Set((worldgen['biome/' + b.name].features ?? []).flat().map((f: string) => f)));
    for (const k of Object.keys(worldgen)) if (k.startsWith('carver/')) this.carvers.set('minecraft:' + k.slice(7), worldgen[k]);
    this.engine = new Engine(reg, worldgen, this.tags, this.density, (n) => biomes.id(n), (b) => this.biomeFeatureSets[b]);
    this.engine.coldEnough = (b, x, y, z) => this.temperature(b, x, y, z) < 0.15;
    if (opts.type === 'flat') {
      const preset = worldgen['flat_level_generator_preset/' + (opts.flatPreset ?? 'classic_flat')];
      this.flatLayers = [];
      for (const l of preset.settings.layers) for (let i = 0; i < l.height; i++) this.flatLayers.push(reg.defaultState(l.block.replace('minecraft:', '')));
      this.singleBiome = biomes.id(preset.settings.biome);
    }
    this.structures = new StructureManager(this, structureFiles);
  }

  readonly dimension: Dimension;
  readonly nMinY: number; readonly nHeight: number; readonly seaLevel: number;
  readonly defaultBlock: number; readonly defaultFluid: number;
  private hasAquifers = true;

  /** Biome.getHeightAdjustedTemperature (shared exact port in world/climate.ts). */
  temperature(b: number, x: number, y: number, z: number): number {
    return biomeTemperature(this.biomes.list[b], x, y, z, this.seaLevel);
  }

  /** Climate sample + nearest biome at quart coordinates. */
  /** TheEndBiomeSource.getNoiseBiome */
  endBiome(qx: number, qz: number): number {
    const i = qx >> 2, k = qz >> 2;
    if (i * i + k * k <= 4096) return this.biomes.id('the_end');
    const d = this.router.erosion((i * 2 + 1) * 8, 0, (k * 2 + 1) * 8);
    return this.biomes.id(d > 0.25 ? 'end_highlands' : d >= -0.0625 ? 'end_midlands' : d < -0.21875 ? 'small_end_islands' : 'end_barrens');
  }

  biomeAt(qx: number, qy: number, qz: number): number {
    if (this.singleBiome >= 0) return this.singleBiome;
    if (this.dimension === 'the_end') return this.endBiome(qx, qz);
    const x = qx << 2, y = qy << 2, z = qz << 2;
    const R = this.router;
    void y;
    return this.biomeSource!.find(R.temperature(x, y, z), R.vegetation(x, y, z), R.continents(x, y, z), R.erosion(x, y, z), R.depth(x, y, z), R.ridges(x, y, z));
  }

  /** Biomes for one quart column: y-independent climate sampled once, depth per quart y. */
  biomeColumn(qx: number, qz: number): (qy: number) => number {
    if (this.singleBiome >= 0) { const b = this.singleBiome; return () => b; }
    if (this.dimension === 'the_end') { const b = this.endBiome(qx, qz); return () => b; }
    const x = qx << 2, z = qz << 2;
    const R = this.router;
    const search = this.biomeSource!.column(R.temperature(x, 0, z), R.vegetation(x, 0, z), R.continents(x, 0, z), R.erosion(x, 0, z), R.ridges(x, 0, z));
    return (qy) => search(R.depth(x, qy << 2, z));
  }

  // ---------------------------------------------------------------------------------------------
  generateProto(cx: number, cz: number): ProtoChunk {
    const c = new ProtoChunk(cx, cz);
    const bx = cx * 16, bz = cz * 16;
    this.density.newChunk();
    if (this.flatLayers) {
      for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) this.flatLayers.forEach((s, i) => c.set(x, MIN_Y + i, z, s));
      c.biomes.fill(this.singleBiome);
      return c;
    }
    // biomes (4x4x4 cells); climate params other than depth are y-independent, nearest-point search per cell
    for (let qz = 0; qz < 4; qz++) for (let qx = 0; qx < 4; qx++) {
      const col = this.biomeColumn((bx >> 2) + qx, (bz >> 2) + qz);
      for (let qy = 0; qy < HEIGHT / 4; qy++) c.biomes[(qy << 4) | (qz << 2) | qx] = col((MIN_Y >> 2) + qy);
    }
    const stone = this.defaultBlock, water = this.S.water, lava = this.S.lava;
    const top = this.nMinY + this.nHeight;
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      const X = bx + x, Z = bz + z;
      const surf = this.prelimSurface(X, 0, Z);
      for (let y = top - 1; y >= this.nMinY; y--) {
        const d = this.finalDensity(X, y, Z);
        if (d > 0) { c.states[IDX(x, y, z)] = stone; continue; }
        if (!this.hasAquifers) { if (y < this.seaLevel && this.defaultFluid) c.states[IDX(x, y, z)] = this.defaultFluid; continue; }
        const f = this.fluidAt(X, y, Z, surf);
        if (f) c.states[IDX(x, y, z)] = f === 1 ? water : lava;
      }
    }
    this.buildSurface(c);
    this.carve(c);
    return c;
  }

  /**
   * Aquifer: near the surface the global fluid picker applies (sea level water, lava below y=-54).
   * Deeper, each 16x12x16 aquifer cell gets a fluid level from the 26.3 aquifer noises; positions take
   * the level of the nearest jittered cell centre. Returns 0 air, 1 water, 2 lava.
   */
  private aquiferCells = new Map<number, [number, number, number, number, boolean]>();
  private aquiferCell(gx: number, gy: number, gz: number): [number, number, number, number, boolean] {
    const key = ((gx + 4096) * 8192 + (gz + 4096)) * 64 + (gy + 32);
    let c = this.aquiferCells.get(key);
    if (c) return c;
    const r = this.aquiferRandom.at(gx, gy, gz);
    const px = gx * 16 + r.nextInt(10), py = gy * 12 + r.nextInt(9), pz = gz * 16 + r.nextInt(10);
    let level = -1e9, lava = false;
    if (this.aq.fluid_level_floodedness(px, py, pz) > 0.4) {
      level = Math.floor((py + this.aq.fluid_level_spread(px, py, pz) * 10) / 3) * 3;
      lava = level < -10 && Math.abs(this.aq.lava(px, py, pz)) > 0.3;
    }
    c = [px, py, pz, level, lava];
    if (this.aquiferCells.size > 200000) this.aquiferCells.clear();
    this.aquiferCells.set(key, c);
    return c;
  }

  /**
   * Aquifer: near the surface the global fluid picker applies (sea level water, lava below y=-54).
   * Deeper, each 16x12x16 aquifer cell gets a fluid level from the 26.3 aquifer noises around a jittered
   * centre; a position takes the level of the nearest centre. Returns 0 air, 1 water, 2 lava.
   */
  fluidAt(x: number, y: number, z: number, surfaceLevel?: number): number {
    if (!this.hasAquifers) return y < this.seaLevel ? (this.defaultFluid === this.S.lava ? 2 : this.defaultFluid ? 1 : 0) : 0;
    const surf = surfaceLevel ?? this.prelimSurface(x, 0, z);
    if (y >= surf - 12 || this.opts.type === 'flat') return y < SEA_LEVEL ? 1 : 0;
    if (y < MIN_Y + 10) return 2;
    const gx0 = Math.floor((x - 5) / 16), gy0 = Math.floor((y - 4) / 12), gz0 = Math.floor((z - 5) / 16);
    let best = Infinity, cell: [number, number, number, number, boolean] | null = null;
    for (let ox = 0; ox <= 1; ox++) for (let oy = 0; oy <= 1; oy++) for (let oz = 0; oz <= 1; oz++) {
      const c = this.aquiferCell(gx0 + ox, gy0 + oy, gz0 + oz);
      const dd = (c[0] - x) ** 2 + (c[1] - y) ** 2 + (c[2] - z) ** 2;
      if (dd < best) { best = dd; cell = c; }
    }
    return cell && y < cell[3] ? (cell[4] ? 2 : 1) : 0;
  }

  private buildSurface(c: ProtoChunk): void {
    const bx = c.cx * 16, bz = c.cz * 16;
    const stone = this.defaultBlock;
    const heights = new Int16Array(256);
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      let y = MAX_Y - 1;
      while (y >= MIN_Y && c.get(x, y, z) === 0) y--;
      heights[z * 16 + x] = y + 1;
    }
    const ctx: SurfaceColumnCtx = { x: 0, z: 0, y: 0, biome: 0, stoneDepthAbove: 0, stoneDepthBelow: 0, waterHeight: NO_WATER, surfaceDepth: 0, surfaceSecondary: 0, minSurfaceLevel: 0, steep: false };
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      const X = bx + x, Z = bz + z;
      ctx.x = X; ctx.z = Z;
      ctx.surfaceDepth = Math.trunc(this.surfaceNoise.getValue(X, 0, Z) * 2.75 + 3 + this.noiseRandom.at(X, 0, Z).nextDouble() * 0.25);
      ctx.surfaceSecondary = this.secondaryNoise.getValue(X, 0, Z);
      ctx.minSurfaceLevel = Math.floor(this.router.chunk_surface_level ? this.router.chunk_surface_level(X, 0, Z) : this.prelimSurface(X, 0, Z)) - 8;
      const hz0 = heights[Math.max(z - 1, 0) * 16 + x], hz1 = heights[Math.min(z + 1, 15) * 16 + x];
      const hx0 = heights[z * 16 + Math.max(x - 1, 0)], hx1 = heights[z * 16 + Math.min(x + 1, 15)];
      ctx.steep = hz1 >= hz0 + 4 || hx0 >= hx1 + 4;
      let stoneAbove = 0, water = NO_WATER, stoneBottom = 2147483647;
      for (let y = heights[z * 16 + x]; y >= MIN_Y; y--) {
        const s = c.get(x, y, z);
        if (s === 0) { stoneAbove = 0; water = NO_WATER; continue; }
        if (s !== stone) { if (water === NO_WATER) water = y + 1; continue; }
        if (stoneBottom >= y) {
          stoneBottom = -2147483648;
          for (let u = y - 1; u >= MIN_Y - 1; u--) if (u < MIN_Y || c.get(x, u, z) !== stone) { stoneBottom = u + 1; break; }
        }
        stoneAbove++;
        ctx.y = y; ctx.stoneDepthAbove = stoneAbove; ctx.stoneDepthBelow = y - stoneBottom + 1; ctx.waterHeight = water;
        ctx.biome = c.biome(x, y, z);
        const r = this.surface.rule(ctx);
        if (r >= 0) c.set(x, y, z, r);
      }
    }
  }

  private carve(c: ProtoChunk): void {
    const biomeSet = new Set<number>();
    for (let i = 0; i < c.biomes.length; i += 7) biomeSet.add(c.biomes[i]);
    const names = new Set<string>();
    for (const b of biomeSet) for (const n of this.worldgen['biome/' + this.biomes.list[b].name].carvers ?? []) names.add(n);
    const list: [string, any][] = [...this.carvers].filter(([n]) => names.has(n));
    const repl = this.tags.block(this.dimension === 'the_nether' ? 'nether_carver_replaceables' : 'overworld_carver_replaceables');
    const t: CarveTarget = {
      cx: c.cx, cz: c.cz, minY: MIN_Y, height: HEIGHT,
      get: (x, y, z) => c.get(x, y, z), set: (x, y, z, s) => c.set(x, y, z, s),
      replaceable: (s) => repl.has(this.reg.stateBlock[s]) && s !== this.S.water,
      isGrass: (s) => s === this.S.grass_block || this.reg.name(s) === 'mycelium' || this.reg.name(s) === 'podzol',
      isDirt: (s) => s === this.S.dirt,
      air: 0, lava: this.S.lava, water: this.S.water, grass: this.S.grass_block,
      sample: (name, j, r) => (name === 'y' ? this.engine.sampleHeight(j, r, this.bounds()) : typeof j === 'number' ? j : this.engine.sampleHeight({ ...j, min_inclusive: { absolute: j.min_inclusive }, max_inclusive: { absolute: j.max_inclusive } }, r, this.bounds())),
      fluidAt: (x, y, z) => { const f = this.fluidAt(x, y, z); return f === 1 ? this.S.water : f === 2 ? this.S.lava : 0; },
    };
    applyCarvers(t, this.opts.seed, list);
  }

  private bounds(): GenAccess {
    return { minY: MIN_Y, maxY: MAX_Y, seaLevel: SEA_LEVEL } as GenAccess;
  }

  /**
   * Deterministic, order-independent decoration: decorate chunk (cx,cz) on private copies of its 3x3
   * proto neighbourhood and return the block writes per neighbour chunk as [index, state] pairs.
   * A final chunk is its proto plus the write lists of the 9 decorations that touch it, applied in
   * canonical order (see applyWrites), so the world is identical for any load order or thread count.
   */
  decorateIsolated(cx: number, cz: number, protos: Map<string, ProtoChunk>): Map<string, Uint32Array> {
    const copies = new Map<string, ProtoChunk>();
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const k = (cx + dx) + ',' + (cz + dz);
      const src = protos.get(k);
      if (!src) throw new Error('decorate needs proto ' + k);
      const c = new ProtoChunk(src.cx, src.cz);
      c.states.set(src.states); c.biomes.set(src.biomes);
      copies.set(k, c);
    }
    this.decorate(copies.get(cx + ',' + cz)!, (x, z) => copies.get(x + ',' + z)!);
    const out = new Map<string, Uint32Array>();
    for (const [k, c] of copies) {
      const src = protos.get(k)!;
      const w: number[] = [];
      for (let i = 0; i < c.states.length; i++) if (c.states[i] !== src.states[i]) w.push(i, c.states[i]);
      if (w.length) out.set(k, Uint32Array.from(w));
    }
    return out;
  }

  /** Final chunk = proto + the 9 decoration write lists that touch it, in canonical (dx, dz) order. */
  static applyWrites(proto: ProtoChunk, writes: (Uint32Array | undefined)[]): void {
    for (const w of writes) if (w) for (let i = 0; i < w.length; i += 2) proto.states[w[i]] = w[i + 1];
  }

  // ---------------------------------------------------------------------------------------------
  /** ChunkGenerator.applyBiomeDecoration for the centre chunk of a 3x3 region of proto chunks. */
  decorate(center: ProtoChunk, neighbour: (cx: number, cz: number) => ProtoChunk): void {
    if (this.opts.type === 'flat') { center.decorated = true; this.structures.place(center, this.access(center, neighbour), 4); return; }
    const g = this.access(center, neighbour);
    const bx = center.cx * 16, bz = center.cz * 16;
    const rnd = new Xoroshiro(0n, 0n);
    const setSeed = (s: bigint) => rnd.setSeed(s);
    setSeed(this.opts.seed);
    const a = rnd.nextLong() | 1n, b = rnd.nextLong() | 1n;
    const decoSeed = BigInt.asIntN(64, (BigInt(bx) * a + BigInt(bz) * b) ^ this.opts.seed);
    const present = new Set<number>();
    for (let i = 0; i < center.biomes.length; i++) present.add(center.biomes[i]);
    for (let step = 0; step < 11; step++) {
      this.structures.place(center, g, step);
      const list = this.stepFeatures[step];
      for (let fi = 0; fi < list.length; fi++) {
        const f = list[fi];
        let any = false;
        for (const bi of present) if (this.biomeFeatureSets[bi].has(f)) { any = true; break; }
        if (!any) continue;
        setSeed(BigInt.asIntN(64, decoSeed + BigInt(fi) + 10000n * BigInt(step)));
        const pf = this.worldgen['placed_feature/' + f.replace('minecraft:', '')];
        if (!pf) continue;
        try { this.engine.placeFeature(pf, g, rnd, bx, MIN_Y, bz, f, true); }
        catch (e) { throw new Error(`feature ${f}: ${(e as Error).message}`); }
      }
    }
    center.decorated = true;
  }

  access(center: ProtoChunk, neighbour: (cx: number, cz: number) => ProtoChunk): GenAccess {
    const reg = this.reg; const eng = () => this.engine;
    const chunkAt = (x: number, z: number): ProtoChunk | null => {
      const cx = x >> 4, cz = z >> 4;
      if (Math.abs(cx - center.cx) > 1 || Math.abs(cz - center.cz) > 1) return null;
      return cx === center.cx && cz === center.cz ? center : neighbour(cx, cz);
    };
    const blocksMotion = (s: number, leaves: boolean) => {
      if (s === 0) return false;
      const n = reg.name(s);
      if (!leaves && n.endsWith('_leaves')) return false;
      return eng().solid(s) || n.endsWith('_leaves');
    };
    return {
      minY: MIN_Y, maxY: MAX_Y, seaLevel: SEA_LEVEL,
      get: (x, y, z) => { const c = chunkAt(x, z); return c ? c.get(x & 15, y, z & 15) : 0; },
      set: (x, y, z, s) => { const c = chunkAt(x, z); if (c) c.set(x & 15, y, z & 15, s); },
      inBounds: (x, z) => chunkAt(x, z) !== null,
      biome: (x, y, z) => { const c = chunkAt(x, z); return c ? c.biome(x & 15, y, z & 15) : center.biome(8, y, 8); },
      height: (kind, x, z) => {
        const c = chunkAt(x, z); if (!c) return MIN_Y;
        const lx = x & 15, lz = z & 15;
        for (let y = MAX_Y - 1; y >= MIN_Y; y--) {
          const s = c.get(lx, y, lz);
          if (s === 0) continue;
          switch (kind) {
            case 'WORLD_SURFACE': case 'WORLD_SURFACE_WG': if (!reg.name(s).endsWith('_air')) return y + 1; break;
            case 'OCEAN_FLOOR': case 'OCEAN_FLOOR_WG': if (blocksMotion(s, true)) return y + 1; break;
            case 'MOTION_BLOCKING': if (blocksMotion(s, true) || reg.name(s) === 'water' || reg.name(s) === 'lava') return y + 1; break;
            case 'MOTION_BLOCKING_NO_LEAVES': if (blocksMotion(s, false) || reg.name(s) === 'water' || reg.name(s) === 'lava') return y + 1; break;
            default: return y + 1;
          }
        }
        return MIN_Y;
      },
    };
  }
}
