// Generation worker: proto chunks (noise/biomes/surface/carvers) and isolated decoration.
import { WorldGenerator, ProtoChunk } from '../worldgen/generator';
import { BlockRegistry } from '../world/registry';
import { Biomes } from '../world/biomes';
import type { ToGen, FromGen } from './protocol';

let gen: WorldGenerator | null = null;
const post = (m: FromGen, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);

/** Synchronous structure template fetch (templates are small and cached by the generator). */
function fetchSync(url: string): Uint8Array | null {
  const x = new XMLHttpRequest();
  x.open('GET', url, false);
  x.overrideMimeType('text/plain; charset=x-user-defined');
  x.send();
  if (x.status !== 200 || (x.getResponseHeader('content-type') ?? '').includes('text/html')) return null;
  const s = x.responseText; const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
}

self.onmessage = (e: MessageEvent<ToGen>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      const reg = new BlockRegistry(m.blocks);
      const biomes = new Biomes(m.worldgen, m.grass, m.foliage, m.dryFoliage);
      gen = new WorldGenerator({ seed: BigInt(m.config.seed), type: m.config.type, singleBiome: m.config.singleBiome, structures: m.config.structures, flatPreset: m.config.flatPreset, bonusChest: m.config.bonusChest },
        m.worldgen, m.tags, reg, biomes, (p) => fetchSync(m.structureBase + p));
      post({ type: 'ready' });
    } else if (m.type === 'proto') {
      const c = gen!.generateProto(m.cx, m.cz);
      post({ type: 'proto', id: m.id, cx: m.cx, cz: m.cz, states: c.states, biomes: c.biomes }, [c.states.buffer, c.biomes.buffer]);
    } else if (m.type === 'decorate') {
      const protos = new Map<string, ProtoChunk>();
      for (const p of m.protos) { const c = new ProtoChunk(p.cx, p.cz); c.states.set(p.states); c.biomes.set(p.biomes); protos.set(p.cx + ',' + p.cz, c); }
      const w = gen!.decorateIsolated(m.cx, m.cz, protos);
      const writes = [...w].map(([key, arr]) => ({ key, w: arr }));
      post({ type: 'decorated', id: m.id, cx: m.cx, cz: m.cz, writes }, writes.map((x) => x.w.buffer));
    }
  } catch (err) {
    post({ type: 'error', id: (m as any).id ?? -1, message: String((err as Error).stack ?? err) });
  }
};
