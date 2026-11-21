import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { DensityContext } from '../src/worldgen/density';
import { Xoroshiro } from '../src/worldgen/random';

const wg = JSON.parse(fs.readFileSync(new URL('../public/gen/data/worldgen.json', import.meta.url), 'utf8'));

describe('overworld density', () => {
  it('produces a plausible surface and is deterministic', () => {
    const run = () => {
      const ctx = new DensityContext(wg, Xoroshiro.fromSeed(42n).forkPositional(), 42n);
      const fd = ctx.compile(wg['noise_settings/overworld'].noise_router.final_density);
      const heights: number[] = [];
      const t0 = performance.now();
      for (let x = 0; x < 64; x += 16) for (let z = 0; z < 64; z += 16) {
        let h = -64;
        for (let y = 319; y >= -64; y--) if (fd(x, y, z) > 0) { h = y; break; }
        heights.push(h);
      }
      return { heights, ms: performance.now() - t0 };
    };
    const a = run(), b = run();
    console.log('surface heights', a.heights.join(','), `${a.ms.toFixed(0)}ms`);
    expect(a.heights).toEqual(b.heights);
    for (const h of a.heights) expect(h).toBeGreaterThan(-64);
  });
});
