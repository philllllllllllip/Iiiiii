// World: loaded chunks and block/light accessors in world coordinates.
import { Chunk, chunkKey, MIN_Y, HEIGHT, idx } from './chunk';

export class World {
  readonly chunks = new Map<number, Chunk>();
  /** Sections touched since last drained: key = chunkKey*32 + sectionIndex */
  readonly dirtySections = new Set<number>();

  getChunk(cx: number, cz: number): Chunk | undefined { return this.chunks.get(chunkKey(cx, cz)); }
  addChunk(c: Chunk): void { this.chunks.set(chunkKey(c.cx, c.cz), c); }
  removeChunk(cx: number, cz: number): void { this.chunks.delete(chunkKey(cx, cz)); }

  getState(x: number, y: number, z: number): number {
    if (y < MIN_Y || y >= MIN_Y + HEIGHT) return 0;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    return c ? c.get(x & 15, y, z & 15) : 0;
  }
  /** -1 when the position is outside loaded chunks. */
  getStateOrUnloaded(x: number, y: number, z: number): number {
    if (y < MIN_Y || y >= MIN_Y + HEIGHT) return 0;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    return c ? c.get(x & 15, y, z & 15) : -1;
  }
  setState(x: number, y: number, z: number, s: number): void {
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c || y < MIN_Y || y >= MIN_Y + HEIGHT) return;
    c.set(x & 15, y, z & 15, s);
    this.markDirty(x, y, z);
  }
  markDirty(x: number, y: number, z: number): void {
    const sy = (y - MIN_Y) >> 4;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) {
      const nx = x + dx, nz = z + dz, ny = y + dy;
      const nsy = (ny - MIN_Y) >> 4;
      if (nsy < 0 || nsy >= HEIGHT / 16) continue;
      if (((nx >> 4) !== (x >> 4)) || ((nz >> 4) !== (z >> 4)) || nsy !== sy || (dx === 0 && dy === 0 && dz === 0)) {
        this.dirtySections.add(chunkKey(nx >> 4, nz >> 4) * 32 + nsy);
      }
    }
    this.dirtySections.add(chunkKey(x >> 4, z >> 4) * 32 + sy);
  }
  sky(x: number, y: number, z: number): number {
    if (y >= MIN_Y + HEIGHT) return 15;
    if (y < MIN_Y) return 0;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return 15;
    const yy = y - MIN_Y;
    return c.sections[yy >> 4].sky[idx(x & 15, yy & 15, z & 15)];
  }
  blockLight(x: number, y: number, z: number): number {
    if (y < MIN_Y || y >= MIN_Y + HEIGHT) return 0;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return 0;
    const yy = y - MIN_Y;
    return c.sections[yy >> 4].block[idx(x & 15, yy & 15, z & 15)];
  }
  biome(x: number, y: number, z: number): number {
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    return c ? c.biome(x & 15, y, z & 15) : 0;
  }
}
