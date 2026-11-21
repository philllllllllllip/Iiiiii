import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { WorldGenerator, type ProtoChunk } from '../src/worldgen/generator';
import { BlockRegistry } from '../src/world/registry';
import { Biomes } from '../src/world/biomes';
import { decodePng } from '../src/assets/png';

const GEN = path.resolve(__dirname, '..', 'public', 'gen');
const J = (f: string) => JSON.parse(fs.readFileSync(path.join(GEN, f), 'utf8'));
const png = (f: string) => decodePng(new Uint8Array(fs.readFileSync(path.join(GEN, f))));
const worldgen = J('data/worldgen.json'), tags = J('data/tags.json');
const reg = new BlockRegistry(J('blocks.json'));
const biomes = new Biomes(worldgen, png('textures/colormap/grass.png'), png('textures/colormap/foliage.png'), png('textures/colormap/dry_foliage.png'));
const files = (p: string) => { const f = path.join(GEN, 'data', 'structure', p); return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null; };

function build(seed: bigint, R = 1) {
  const g = new WorldGenerator({ seed, type: 'normal', structures: true }, worldgen, tags, reg, biomes, files);
  const protos = new Map<string, ProtoChunk>();
  const get = (x: number, z: number) => { const k = x + ',' + z; let p = protos.get(k); if (!p) { p = g.generateProto(x, z); protos.set(k, p); } return p; };
  const t0 = performance.now();
  for (let x = -R - 1; x <= R + 1; x++) for (let z = -R - 1; z <= R + 1; z++) get(x, z);
  const tProto = performance.now() - t0;
  const t1 = performance.now();
  for (let x = -R; x <= R; x++) for (let z = -R; z <= R; z++) g.decorate(get(x, z), get);
  const tDeco = performance.now() - t1;
  return { g, get, tProto, tDeco, n: (2 * R + 3) ** 2 };
}

describe('world generation', () => {
  it('is deterministic for a seed and produces terrain', () => {
    const a = build(12345n), b = build(12345n);
    console.log(`proto ${(a.tProto / a.n).toFixed(1)} ms/chunk, decorate ${(a.tDeco / 9).toFixed(1)} ms/chunk`);
    let diff = 0, nonAir = 0;
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
      const pa = a.get(x, z), pb = b.get(x, z);
      for (let i = 0; i < pa.states.length; i++) { if (pa.states[i] !== pb.states[i]) diff++; if (pa.states[i]) nonAir++; }
      expect(Array.from(pa.biomes)).toEqual(Array.from(pb.biomes));
    }
    expect(diff).toBe(0);
    expect(nonAir).toBeGreaterThan(100000);
    const counts = new Map<string, number>();
    const c = a.get(0, 0);
    for (let i = 0; i < c.states.length; i++) { const n = reg.name(c.states[i]); counts.set(n, (counts.get(n) ?? 0) + 1); }
    console.log([...counts].sort((x, y) => y[1] - x[1]).slice(0, 25).map((e) => e.join(':')).join(' '));
    console.log('biomes', [...new Set(Array.from(c.biomes).map((b) => biomes.list[b].name))].join(','));
    console.log('features', [...a.g.engine.stats].map((e) => e.join(':')).join(' '));
  }, 300000);
});
