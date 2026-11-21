// Chunk storage: 24 sections of 16x16x16 (y -64..319). Block states as dense ids; light as one byte
// per block for each of sky and block light (0..15).
export const MIN_Y = -64;
export const HEIGHT = 384;
export const SECTIONS = HEIGHT / 16;

export const idx = (x: number, y: number, z: number) => (y << 8) | (z << 4) | x;

export class Section {
  states: Uint16Array;
  sky: Uint8Array;
  block: Uint8Array;
  nonAir = 0;
  constructor(states?: Uint16Array, sky?: Uint8Array, block?: Uint8Array) {
    this.states = states ?? new Uint16Array(4096);
    this.sky = sky ?? new Uint8Array(4096);
    this.block = block ?? new Uint8Array(4096);
  }
}

export class Chunk {
  readonly sections: Section[] = [];
  /** WORLD_SURFACE-like heightmap: y of highest non-air block + 1, per column (z*16+x) */
  readonly heightmap = new Int16Array(256).fill(MIN_Y);
  biomes: Uint8Array = new Uint8Array(4 * 4 * (HEIGHT / 4)); // vanilla 4x4x4 biome cells
  lit = false;
  generated = false;
  dirty = false;
  constructor(readonly cx: number, readonly cz: number) {
    for (let i = 0; i < SECTIONS; i++) this.sections.push(new Section());
  }
  get(x: number, y: number, z: number): number {
    const yy = y - MIN_Y;
    if (yy < 0 || yy >= HEIGHT) return 0;
    return this.sections[yy >> 4].states[idx(x, yy & 15, z)];
  }
  set(x: number, y: number, z: number, s: number): void {
    const yy = y - MIN_Y;
    if (yy < 0 || yy >= HEIGHT) return;
    const sec = this.sections[yy >> 4];
    const i = idx(x, yy & 15, z);
    const old = sec.states[i];
    if (old === s) return;
    if (old === 0) sec.nonAir++; else if (s === 0) sec.nonAir--;
    sec.states[i] = s;
  }
  biome(x: number, y: number, z: number): number {
    const by = Math.max(0, Math.min(HEIGHT / 4 - 1, (y - MIN_Y) >> 2));
    return this.biomes[(by << 4) | ((z >> 2) << 2) | (x >> 2)];
  }
  recountSection(i: number): void {
    let n = 0; const st = this.sections[i].states;
    for (let k = 0; k < 4096; k++) if (st[k] !== 0) n++;
    this.sections[i].nonAir = n;
  }
}

export const chunkKey = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);
