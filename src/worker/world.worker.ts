// World worker: owns the authoritative chunk store, lighting and meshing, and schedules generation on
// a pool of generation workers. Pipeline per chunk C (vanilla-equivalent statuses):
//   proto(5x5 around C) -> decorate(3x3 around C, isolated) -> final(C) -> light -> mesh (when the
//   8 neighbours are final too).
import { BlockRegistry } from '../world/registry';
import { BlockInfo } from '../world/blockinfo';
import { Biomes } from '../world/biomes';
import { World } from '../world/world';
import { Chunk, Section, SECTIONS, MIN_Y } from '../world/chunk';
import { LightEngine } from '../world/light';
import { Mesher } from '../mesh/mesher';
import { WorldGenerator } from '../worldgen/generator';
import { WorldStore } from '../save/store';
import type { ToWorld, FromWorld, ToGen, FromGen, StaticData, WorldConfig } from './protocol';
import { sectionKey } from './protocol';

const post = (m: FromWorld, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);
const key = (x: number, z: number) => x + ',' + z;

interface ProtoData { states: Uint16Array; biomes: Uint8Array }

let reg: BlockRegistry, info: BlockInfo, biomes: Biomes, world: World, light: LightEngine, mesher: Mesher;
let probe: WorldGenerator;
let store: WorldStore | null = null;
let config: WorldConfig;
const protos = new Map<string, ProtoData>();
const protoPending = new Set<string>();
const decorated = new Set<string>();
const decoPending = new Set<string>();
/** writes[target][source] */
const writes = new Map<string, Map<string, Uint32Array>>();
const finals = new Set<string>();
const meshQueue = new Set<number>(); // section keys
const modified = new Set<string>();
let view = { x: 0, y: 64, z: 0, rd: 8 };
const gens: { w: Worker; busy: number; ready: boolean }[] = [];
let jobId = 0;
const saved = new Map<string, { states: Uint16Array; biomes: Uint8Array }>();

function startGenWorkers(n: number, data: StaticData) {
  for (let i = 0; i < n; i++) {
    const w = new Worker(new URL('./gen.worker.ts', import.meta.url), { type: 'module' });
    const g = { w, busy: 0, ready: false };
    w.onmessage = (e: MessageEvent<FromGen>) => onGen(g, e.data);
    w.onerror = (e) => post({ type: 'error', message: 'gen worker: ' + e.message });
    const init: ToGen = { type: 'init', worldgen: data.worldgen, tags: data.tags, blocks: data.blocks, grass: data.grass, foliage: data.foliage, dryFoliage: data.dryFoliage, config, structureBase: data.structureBase };
    w.postMessage(init);
    gens.push(g);
  }
}

function onGen(g: (typeof gens)[number], m: FromGen) {
  if (m.type === 'ready') { g.ready = true; pump(); return; }
  g.busy--;
  if (m.type === 'error') { post({ type: 'error', message: m.message }); return; }
  if (m.type === 'proto') {
    const k = key(m.cx, m.cz);
    protoPending.delete(k);
    protos.set(k, { states: m.states, biomes: m.biomes });
  } else if (m.type === 'decorated') {
    const k = key(m.cx, m.cz);
    decoPending.delete(k);
    decorated.add(k);
    for (const { key: t, w } of m.writes) {
      let mm = writes.get(t);
      if (!mm) { mm = new Map(); writes.set(t, mm); }
      mm.set(k, w);
    }
  }
  pump();
}

function idleGen() {
  let best: (typeof gens)[number] | null = null;
  for (const g of gens) if (g.ready && g.busy < 2 && (!best || g.busy < best.busy)) best = g;
  return best;
}

/** Desired chunks within render distance, nearest first. */
function desired(): [number, number][] {
  const cx = Math.floor(view.x / 16), cz = Math.floor(view.z / 16);
  const out: [number, number, number][] = [];
  const R = view.rd;
  for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) if (dx * dx + dz * dz <= (R + 0.5) * (R + 0.5)) out.push([cx + dx, cz + dz, dx * dx + dz * dz]);
  out.sort((a, b) => a[2] - b[2]);
  return out.map(([x, z]) => [x, z]);
}

let pumping = false;
function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (const [cx, cz] of desired()) {
      if (!idleGen()) break;
      const k = key(cx, cz);
      if (finals.has(k)) continue;
      if (saved.has(k)) { finalizeSaved(cx, cz); continue; }
      // need all 9 decorations around C
      let allDecorated = true;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const dk = key(cx + dx, cz + dz);
        if (decorated.has(dk)) continue;
        allDecorated = false;
        if (decoPending.has(dk)) continue;
        // decoration of D needs protos 3x3 around D
        let have = true;
        for (let ex = -1; ex <= 1; ex++) for (let ez = -1; ez <= 1; ez++) {
          const pk = key(cx + dx + ex, cz + dz + ez);
          if (protos.has(pk)) continue;
          have = false;
          if (protoPending.has(pk)) continue;
          const g = idleGen(); if (!g) continue;
          protoPending.add(pk); g.busy++;
          g.w.postMessage({ type: 'proto', id: jobId++, cx: cx + dx + ex, cz: cz + dz + ez } satisfies ToGen);
        }
        if (have) {
          const g = idleGen(); if (!g) continue;
          const list = [];
          for (let ex = -1; ex <= 1; ex++) for (let ez = -1; ez <= 1; ez++) {
            const p = protos.get(key(cx + dx + ex, cz + dz + ez))!;
            list.push({ cx: cx + dx + ex, cz: cz + dz + ez, states: p.states, biomes: p.biomes });
          }
          decoPending.add(dk); g.busy++;
          g.w.postMessage({ type: 'decorate', id: jobId++, cx: cx + dx, cz: cz + dz, protos: list } satisfies ToGen);
        }
      }
      if (allDecorated && protos.has(k)) finalize(cx, cz);
    }
    // finalize anything that became ready even when generators are busy
    for (const [cx, cz] of desired()) {
      const k = key(cx, cz);
      if (finals.has(k) || !protos.has(k)) continue;
      let ok = true;
      for (let dx = -1; dx <= 1 && ok; dx++) for (let dz = -1; dz <= 1 && ok; dz++) if (!decorated.has(key(cx + dx, cz + dz))) ok = false;
      if (ok) finalize(cx, cz);
    }
  } finally { pumping = false; }
  post({ type: 'progress', loaded: finals.size, pending: protoPending.size + decoPending.size });
  scheduleMesh();
}

function makeChunk(cx: number, cz: number, states: Uint16Array, biomeData: Uint8Array): Chunk {
  const c = new Chunk(cx, cz);
  for (let i = 0; i < SECTIONS; i++) c.sections[i] = new Section(states.subarray(i * 4096, (i + 1) * 4096));
  c.biomes = biomeData;
  for (let i = 0; i < SECTIONS; i++) c.recountSection(i);
  return c;
}

function finalize(cx: number, cz: number) {
  const k = key(cx, cz);
  const p = protos.get(k)!;
  const states = p.states.slice();
  const ws = writes.get(k);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const w = ws?.get(key(cx + dx, cz + dz));
    if (w) for (let i = 0; i < w.length; i += 2) states[w[i]] = w[i + 1];
  }
  addFinal(makeChunk(cx, cz, states, p.biomes.slice()));
}

function finalizeSaved(cx: number, cz: number) {
  const s = saved.get(key(cx, cz))!;
  addFinal(makeChunk(cx, cz, s.states.slice(), s.biomes.slice()));
}

function addFinal(c: Chunk) {
  const k = key(c.cx, c.cz);
  world.addChunk(c);
  finals.add(k);
  light.lightChunk(c);
  sendChunk(c);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) queueChunkMesh(c.cx + dx, c.cz + dz);
}

function sendChunk(c: Chunk) {
  const states = new Uint16Array(SECTIONS * 4096), sky = new Uint8Array(SECTIONS * 4096), block = new Uint8Array(SECTIONS * 4096);
  c.sections.forEach((s, i) => { states.set(s.states, i * 4096); sky.set(s.sky, i * 4096); block.set(s.block, i * 4096); });
  const biomeCopy = c.biomes.slice();
  post({ type: 'chunk', cx: c.cx, cz: c.cz, states, sky, block, biomes: biomeCopy }, [states.buffer, sky.buffer, block.buffer, biomeCopy.buffer]);
}

const meshable = (cx: number, cz: number) => {
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (!finals.has(key(cx + dx, cz + dz))) return false;
  return true;
};
function queueChunkMesh(cx: number, cz: number) {
  if (!meshable(cx, cz)) return;
  const c = world.getChunk(cx, cz)!;
  for (let s = 0; s < SECTIONS; s++) {
    // empty sections still need meshing when a neighbour section has content at the border; air-only sections produce nothing
    if (c.sections[s].nonAir > 0) meshQueue.add(sectionKey(cx, s + MIN_Y / 16, cz));
  }
}

let meshTimer = 0;
function scheduleMesh() {
  if (meshTimer) return;
  meshTimer = setTimeout(meshStep, 0) as unknown as number;
}
function meshStep() {
  meshTimer = 0;
  // light-driven dirty sections
  for (const d of world.dirtySections) {
    const sy = (d % 32) - 4; const ck = Math.floor(d / 32);
    const cx = Math.floor(ck / 65536) - 32768, cz = (ck % 65536) - 32768;
    if (meshable(cx, cz)) meshQueue.add(sectionKey(cx, sy, cz));
  }
  world.dirtySections.clear();
  if (!meshQueue.size) return;
  const vx = Math.floor(view.x / 16), vy = Math.floor(view.y / 16), vz = Math.floor(view.z / 16);
  const decode = (k: number) => { const sy = (k % 32) - 4; const ck = Math.floor(k / 32); return [Math.floor(ck / 65536) - 32768, sy, (ck % 65536) - 32768]; };
  const list = [...meshQueue].map((k) => { const [x, y, z] = decode(k); return { k, x, y, z, d: (x - vx) ** 2 + ((y - vy) ** 2) * 0.5 + (z - vz) ** 2 }; }).sort((a, b) => a.d - b.d);
  const t0 = performance.now();
  for (const s of list) {
    if (performance.now() - t0 > 12) break;
    meshQueue.delete(s.k);
    if (!world.getChunk(s.x, s.z)) continue;
    const m = mesher.meshSection(world, s.x, s.y, s.z);
    const c = world.getChunk(s.x, s.z)!;
    const sec = c.sections[s.y - MIN_Y / 16];
    post({ type: 'sectionLight', cx: s.x, cz: s.z, sy: s.y, sky: sec.sky.slice(), block: sec.block.slice() });
    post({ type: 'mesh', key: s.k, sx: s.x, sy: s.y, sz: s.z, layers: m.layers, quads: m.quads, centers: m.centers }, [...m.layers, m.centers.buffer]);
  }
  if (meshQueue.size) scheduleMesh();
}

function unloadFar() {
  const cx = Math.floor(view.x / 16), cz = Math.floor(view.z / 16);
  const R = view.rd + 2, R2 = view.rd + 5;
  for (const k of [...finals]) {
    const [x, z] = k.split(',').map(Number);
    if (Math.max(Math.abs(x - cx), Math.abs(z - cz)) > R) {
      const c = world.getChunk(x, z);
      if (c && modified.has(k)) persistChunk(c);
      world.removeChunk(x, z);
      finals.delete(k);
      const keys: number[] = [];
      for (let s = 0; s < SECTIONS; s++) { const sk = sectionKey(x, s + MIN_Y / 16, z); keys.push(sk); meshQueue.delete(sk); }
      post({ type: 'unload', cx: x, cz: z, keys });
    }
  }
  for (const k of [...protos.keys()]) { const [x, z] = k.split(',').map(Number); if (Math.max(Math.abs(x - cx), Math.abs(z - cz)) > R2) protos.delete(k); }
  for (const k of [...decorated]) { const [x, z] = k.split(',').map(Number); if (Math.max(Math.abs(x - cx), Math.abs(z - cz)) > R2) { decorated.delete(k); } }
  for (const k of [...writes.keys()]) { const [x, z] = k.split(',').map(Number); if (Math.max(Math.abs(x - cx), Math.abs(z - cz)) > R2) writes.delete(k); }
}

function persistChunk(c: Chunk) {
  const states = new Uint16Array(SECTIONS * 4096);
  c.sections.forEach((s, i) => states.set(s.states, i * 4096));
  const k = key(c.cx, c.cz);
  saved.set(k, { states, biomes: c.biomes.slice() });
  store?.putChunk(c.cx, c.cz, states, c.biomes);
}

function findSpawn(): [number, number, number] {
  if (config.dimension === 'the_end') return [100.5, 49, 0.5]; // EndPlatformFeature spawn
  if (config.dimension === 'the_nether') {
    // first air pocket above ground at the column nearest 0,0 (portal search approximation)
    for (let r = 0; r < 32; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const x = dx * 8, z = dz * 8;
      const fd = (probe as any).finalDensity;
      for (let y = 40; y < 110; y++) if (fd(x, y - 1, z) > 0 && fd(x, y, z) <= 0 && fd(x, y + 1, z) <= 0 && fd(x, y + 2, z) <= 0) return [x + 0.5, y, z + 0.5];
    }
    return [0.5, 70, 0.5];
  }
  // WorldGenerator spawn search: nearest non-ocean column with a dry surface, spiralling out from 0,0
  for (let r = 0; r < 64; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    const x = dx * 16 + 8, z = dz * 16 + 8;
    const y = probe.structures.surfaceY(x, z);
    if (y <= 63) continue;
    const b = biomes.list[probe.biomeAt(x >> 2, y >> 2, z >> 2)].name;
    if (/ocean|river|beach/.test(b)) continue;
    return [x + 0.5, y, z + 0.5];
  }
  return [0.5, 100, 0.5];
}

self.onmessage = async (e: MessageEvent<ToWorld>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init': {
        config = m.config;
        const d = m.data;
        reg = new BlockRegistry(d.blocks);
        info = new BlockInfo(reg, d.models, d.blocks);
        biomes = new Biomes(d.worldgen, d.grass, d.foliage, d.dryFoliage);
        world = new World();
        light = new LightEngine(world, info);
        light.skylight = config.dimension !== 'the_nether';
        mesher = new Mesher(reg, info, biomes, d.blocks, d.spriteSlots, d.spriteNames, { smoothLighting: m.smoothLighting, biomeBlend: m.biomeBlend });
        probe = new WorldGenerator({ seed: BigInt(config.seed), type: config.type, dimension: config.dimension, singleBiome: config.singleBiome, structures: config.structures, flatPreset: config.flatPreset }, d.worldgen, d.tags, reg, biomes, () => null);
        store = await WorldStore.open(m.worldId + (config.dimension && config.dimension !== 'overworld' ? '/' + config.dimension : ''));
        for (const c of await store.allChunks()) saved.set(key(c.cx, c.cz), { states: c.states, biomes: c.biomes });
        startGenWorkers(m.genWorkers, d);
        const meta = await store.getMeta('spawn');
        const spawn = (meta as [number, number, number] | undefined) ?? (config.type === 'flat' ? [0.5, -60, 0.5] as [number, number, number] : findSpawn());
        if (!meta) await store.putMeta('spawn', spawn);
        (self as unknown as Worker).postMessage({ type: 'spawn', x: spawn[0], y: spawn[1], z: spawn[2] });
        post({ type: 'ready' });
        break;
      }
      case 'view':
        view = { x: m.x, y: m.y, z: m.z, rd: m.renderDistance };
        unloadFar();
        pump();
        break;
      case 'setBlock': {
        const c = world.getChunk(m.x >> 4, m.z >> 4);
        if (!c) break;
        world.setState(m.x, m.y, m.z, m.state);
        light.onBlockChanged(m.x, m.y, m.z);
        modified.add(key(c.cx, c.cz));
        // immediate remesh of the touched sections, ahead of everything else
        for (const d of world.dirtySections) {
          const sy = (d % 32) - 4; const ck = Math.floor(d / 32);
          const cx = Math.floor(ck / 65536) - 32768, cz = (ck % 65536) - 32768;
          if (meshable(cx, cz)) meshQueue.add(sectionKey(cx, sy, cz));
        }
        world.dirtySections.clear();
        meshStep();
        break;
      }
      case 'save':
        for (const k of modified) { const [x, z] = k.split(',').map(Number); const c = world.getChunk(x, z); if (c) persistChunk(c); }
        modified.clear();
        await store?.flush();
        post({ type: 'saved' });
        break;
      case 'options':
        mesher.opts.smoothLighting = m.smoothLighting; mesher.opts.biomeBlend = m.biomeBlend;
        for (const k of finals) { const [x, z] = k.split(',').map(Number); queueChunkMesh(x, z); }
        scheduleMesh();
        break;
    }
  } catch (err) {
    post({ type: 'error', message: String((err as Error).stack ?? err) });
  }
};
