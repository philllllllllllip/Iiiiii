// Verifies the asset pipeline output: every atlas frame is a byte-exact copy of its vanilla source,
// padding is an edge extrusion, and every model/blockstate reference resolves.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const GEN = path.resolve(__dirname, '..', 'public', 'gen');
const TEX = path.resolve(__dirname, '..', '.cache', 'vanilla', 'textures', 'assets', 'minecraft', 'textures');
const read = (f: string) => PNG.sync.read(fs.readFileSync(f));
const json = (f: string) => JSON.parse(fs.readFileSync(path.join(GEN, f), 'utf8'));

if (!fs.existsSync(path.join(GEN, 'manifest.json'))) throw new Error('public/gen missing: run `npm run assets` first');

function checkAtlas(name: string, srcPrefix: (sprite: string) => string | null) {
  const atlas = read(path.join(GEN, 'atlas', name + '.png'));
  const man = json(`atlas/${name}.json`);
  let checked = 0;
  for (const [sprite, e] of Object.entries<any>(man.sprites)) {
    const rel = srcPrefix(sprite);
    if (!rel) continue;
    const file = path.join(TEX, rel + '.png');
    if (!fs.existsSync(file)) continue; // generated sprites (missingno, trim permutations)
    const src = read(file);
    const cols = Math.floor(src.width / e.w);
    const used: number[] = e.anim ? [...new Set<number>(e.anim.seq.map((s: number[]) => s[0]))] : [0];
    // map frame slot -> source frame index
    const srcFrames: number[] = [];
    if (e.anim) {
      const meta = JSON.parse(fs.readFileSync(file + '.mcmeta', 'utf8')).animation;
      const n = cols * Math.floor(src.height / e.h);
      const order = (meta.frames ?? [...Array(n).keys()]).map((f: any) => (typeof f === 'number' ? f : f.index));
      srcFrames.push(...[...new Set<number>(order)].sort((a, b) => a - b));
    } else srcFrames.push(0);
    expect(e.frames.length).toBe(srcFrames.length);
    for (let fi = 0; fi < e.frames.length; fi++) {
      const [ax, ay] = e.frames[fi];
      const sf = srcFrames[fi];
      const sx = (sf % cols) * e.w, sy = Math.floor(sf / cols) * e.h;
      for (let y = 0; y < e.h; y++) {
        const a = atlas.data.subarray(((ay + y) * atlas.width + ax) * 4, ((ay + y) * atlas.width + ax + e.w) * 4);
        const s = src.data.subarray(((sy + y) * src.width + sx) * 4, ((sy + y) * src.width + sx + e.w) * 4);
        if (Buffer.compare(Buffer.from(a), Buffer.from(s)) !== 0) throw new Error(`${name}:${sprite} frame ${fi} row ${y} differs`);
      }
      // padding: left column equals first content column
      for (let y = 0; y < e.h; y++) {
        const p = ((ay + y) * atlas.width + ax - 1) * 4, c = ((ay + y) * atlas.width + ax) * 4;
        expect(atlas.data.readUInt32BE(p)).toBe(atlas.data.readUInt32BE(c));
      }
    }
    void used;
    checked++;
  }
  return checked;
}

describe('asset pipeline', () => {
  it('block atlas frames are byte-exact', () => {
    expect(checkAtlas('blocks', (s) => s)).toBeGreaterThan(1300);
  });
  it('item atlas frames are byte-exact', () => {
    expect(checkAtlas('items', (s) => s)).toBeGreaterThan(900);
  });
  it('gui atlas frames are byte-exact', () => {
    expect(checkAtlas('gui', (s) => (s.startsWith('mob_effect/') ? s : 'gui/sprites/' + s))).toBeGreaterThan(500);
  });
  it('every block state resolves to models with valid sprites', () => {
    const blocks = json('blocks.json');
    const models = json('models.json');
    const blockAtlas = json('atlas/blocks.json').sprites;
    const itemAtlas = json('atlas/items.json').sprites;
    for (const name of models.sprites) expect(name in blockAtlas || name in itemAtlas, name).toBe(true);
    let total = 0;
    for (const b of blocks.blocks) total += b.count;
    expect(blocks.states.length).toBe(total);
    for (const sp of blocks.states) for (const p of sp) for (const c of blocks.parts[p]) expect(models.models[c.m]).toBeDefined();
    const stone = blocks.blocks.find((b: any) => b.name === 'stone');
    const m = models.models[blocks.parts[blocks.states[stone.def][0]][0].m];
    expect(m.fullCube).toBe(true);
    expect(models.sprites[m.elements[0].faces.up.tex]).toBe('block/stone');
  });
  it('26.3 registry content is present', () => {
    const blocks = json('blocks.json').blocks.map((b: any) => b.name);
    for (const b of ['sulfur', 'potent_sulfur', 'sulfur_spike', 'polished_sulfur', 'chiseled_sulfur']) expect(blocks).toContain(b);
    const man = json('manifest.json');
    expect(man.version).toBe('26.3');
  });
  it('font advances follow vanilla rules', () => {
    const f = json('font.json');
    expect(f.glyphs[32].advance).toBe(4); // space provider
    expect(f.glyphs['A'.codePointAt(0)!].advance).toBe(6);
    expect(f.glyphs['i'.codePointAt(0)!].advance).toBe(2);
    expect(f.glyphs['l'.codePointAt(0)!].advance).toBe(3);
  });
});
