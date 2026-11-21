// Main-thread world client: talks to the world worker, mirrors chunk block/light data (for physics,
// raycasts and HUD) and hands section meshes to the terrain renderer.
import { World } from './world';
import { Chunk, Section, SECTIONS, MIN_Y } from './chunk';
import type { FromWorld, StaticData, WorldConfig, ToWorld } from '../worker/protocol';
import type { TerrainRenderer } from '../render/terrain';

export class WorldClient {
  readonly world = new World();
  readonly worker: Worker;
  spawn: [number, number, number] | null = null;
  ready = false;
  loaded = 0; pending = 0;
  onError: (msg: string) => void = (m) => console.error(m);
  onSaved: () => void = () => {};
  private readyWaiters: (() => void)[] = [];

  constructor(readonly terrain: TerrainRenderer) {
    this.worker = new Worker(new URL('../worker/world.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorld | { type: 'spawn'; x: number; y: number; z: number }>) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.onError('world worker: ' + e.message);
  }

  init(data: StaticData, config: WorldConfig, worldId: string, smoothLighting: boolean, biomeBlend: number): Promise<void> {
    const genWorkers = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
    this.post({ type: 'init', data, config, worldId, genWorkers, smoothLighting, biomeBlend });
    return new Promise((r) => this.readyWaiters.push(r));
  }
  post(m: ToWorld): void { this.worker.postMessage(m); }

  setView(x: number, y: number, z: number, rd: number): void { this.post({ type: 'view', x, y, z, renderDistance: rd }); }

  setBlock(x: number, y: number, z: number, s: number): void {
    this.world.setState(x, y, z, s);
    this.world.dirtySections.clear();
    this.post({ type: 'setBlock', x, y, z, state: s });
  }

  save(): Promise<void> { return new Promise((r) => { this.onSaved = r; this.post({ type: 'save' }); }); }
  terminate(): void { this.worker.terminate(); }

  private onMessage(m: FromWorld | { type: 'spawn'; x: number; y: number; z: number }): void {
    switch (m.type) {
      case 'spawn': this.spawn = [m.x, m.y, m.z]; break;
      case 'ready': this.ready = true; for (const w of this.readyWaiters) w(); this.readyWaiters = []; break;
      case 'chunk': {
        const c = new Chunk(m.cx, m.cz);
        for (let i = 0; i < SECTIONS; i++) {
          c.sections[i] = new Section(m.states.subarray(i * 4096, (i + 1) * 4096), m.sky.subarray(i * 4096, (i + 1) * 4096), m.block.subarray(i * 4096, (i + 1) * 4096));
          c.recountSection(i);
        }
        c.biomes = m.biomes;
        this.world.addChunk(c);
        break;
      }
      case 'sectionLight': {
        const c = this.world.getChunk(m.cx, m.cz);
        if (c) { const s = c.sections[m.sy - MIN_Y / 16]; s.sky.set(m.sky); s.block.set(m.block); }
        break;
      }
      case 'mesh': this.terrain.upload(m.key, m.sx, m.sy, m.sz, m); break;
      case 'unload': this.world.removeChunk(m.cx, m.cz); for (const k of m.keys) this.terrain.remove(k); break;
      case 'progress': this.loaded = m.loaded; this.pending = m.pending; break;
      case 'saved': this.onSaved(); break;
      case 'error': this.onError(m.message); break;
    }
  }
}
