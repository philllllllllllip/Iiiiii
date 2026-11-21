// IndexedDB world storage. One database; stores:
//   worlds  : world metadata (the level.dat equivalent)            key = worldId
//   chunks  : player-modified chunks (deflated block states+biomes) key = worldId|cx|cz
//   meta    : per-world values (spawn, player, game rules, time)   key = worldId|name
// Unmodified chunks are never stored: generation is deterministic for a seed.
import { deflateSync, inflateSync } from 'fflate';

const DB = 'mc26.3-worlds';
const VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('worlds')) db.createObjectStore('worlds', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export interface WorldMeta {
  id: string; name: string; folder: string; seed: string; type: string; singleBiome?: string;
  gameMode: 'survival' | 'creative' | 'hardcore' | 'adventure' | 'spectator'; difficulty: 'peaceful' | 'easy' | 'normal' | 'hard';
  hardcore: boolean; cheats: boolean; structures: boolean; bonusChest: boolean;
  created: number; lastPlayed: number; icon?: string; version: string;
  gameRules: Record<string, boolean | number>;
}

export class WorldStore {
  private constructor(readonly db: IDBDatabase, readonly worldId: string) {}
  static async open(worldId: string): Promise<WorldStore> { return new WorldStore(await openDb(), worldId); }

  async putChunk(cx: number, cz: number, states: Uint16Array, biomes: Uint8Array): Promise<void> {
    const raw = new Uint8Array(states.byteLength + biomes.byteLength);
    raw.set(new Uint8Array(states.buffer, states.byteOffset, states.byteLength), 0);
    raw.set(biomes, states.byteLength);
    const tx = this.db.transaction('chunks', 'readwrite');
    tx.objectStore('chunks').put({ cx, cz, n: states.length, data: deflateSync(raw) }, `${this.worldId}|${cx}|${cz}`);
    await new Promise((r) => (tx.oncomplete = r));
  }
  async allChunks(): Promise<{ cx: number; cz: number; states: Uint16Array; biomes: Uint8Array }[]> {
    const tx = this.db.transaction('chunks', 'readonly');
    const range = IDBKeyRange.bound(this.worldId + '|', this.worldId + '|￿');
    const rows = await req(tx.objectStore('chunks').getAll(range));
    return rows.map((r: any) => {
      const raw = inflateSync(r.data);
      const states = new Uint16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + r.n * 2));
      return { cx: r.cx, cz: r.cz, states, biomes: raw.slice(r.n * 2) };
    });
  }
  async getMeta(name: string): Promise<unknown> {
    return req(this.db.transaction('meta', 'readonly').objectStore('meta').get(`${this.worldId}|${name}`));
  }
  async putMeta(name: string, value: unknown): Promise<void> {
    const tx = this.db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(value, `${this.worldId}|${name}`);
    await new Promise((r) => (tx.oncomplete = r));
  }
  async flush(): Promise<void> { /* every write commits its own transaction */ }
}

export class WorldList {
  private constructor(readonly db: IDBDatabase) {}
  static async open(): Promise<WorldList> { return new WorldList(await openDb()); }
  async list(): Promise<WorldMeta[]> {
    const all = await req(this.db.transaction('worlds', 'readonly').objectStore('worlds').getAll()) as WorldMeta[];
    return all.sort((a, b) => b.lastPlayed - a.lastPlayed);
  }
  async put(w: WorldMeta): Promise<void> {
    const tx = this.db.transaction('worlds', 'readwrite'); tx.objectStore('worlds').put(w);
    await new Promise((r) => (tx.oncomplete = r));
  }
  async delete(id: string): Promise<void> {
    const tx = this.db.transaction(['worlds', 'chunks', 'meta'], 'readwrite');
    tx.objectStore('worlds').delete(id);
    const range = IDBKeyRange.bound(id + '|', id + '|￿');
    tx.objectStore('chunks').delete(range); tx.objectStore('meta').delete(range);
    await new Promise((r) => (tx.oncomplete = r));
  }
  /** Duplicate a world (metadata, chunks, meta) under a new id. */
  async duplicate(src: WorldMeta, newId: string, newName: string, folder: string): Promise<void> {
    const tx = this.db.transaction(['chunks', 'meta'], 'readonly');
    const range = IDBKeyRange.bound(src.id + '|', src.id + '|￿');
    const [ck, cv, mk, mv] = await Promise.all([
      req(tx.objectStore('chunks').getAllKeys(range)), req(tx.objectStore('chunks').getAll(range)),
      req(tx.objectStore('meta').getAllKeys(range)), req(tx.objectStore('meta').getAll(range)),
    ]);
    const w = this.db.transaction(['worlds', 'chunks', 'meta'], 'readwrite');
    w.objectStore('worlds').put({ ...src, id: newId, name: newName, folder, lastPlayed: Date.now() });
    ck.forEach((k, i) => w.objectStore('chunks').put(cv[i], String(k).replace(src.id + '|', newId + '|')));
    mk.forEach((k, i) => w.objectStore('meta').put(mv[i], String(k).replace(src.id + '|', newId + '|')));
    await new Promise((r) => (w.oncomplete = r));
  }
}
