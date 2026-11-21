// Vanilla model + blockstate resolution. Mirrors BlockModel/UnbakedModel parent inheritance,
// texture reference resolution and BlockElement default UVs.
import fs from 'node:fs';
import path from 'node:path';

export const stripNs = (id) => (id.startsWith('minecraft:') ? id.slice(10) : id);

export class ModelStore {
  constructor(modelsDir) {
    this.dir = modelsDir;
    this.raw = new Map();
    this.resolved = new Map();
  }
  loadRaw(id) {
    id = stripNs(id);
    if (this.raw.has(id)) return this.raw.get(id);
    const file = path.join(this.dir, id + '.json');
    if (!fs.existsSync(file)) throw new Error(`missing model ${id}`);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    this.raw.set(id, j);
    return j;
  }
  /** Flatten parent chain. Returns {id, textures, elements, ao, guiLight, display, generated}. */
  resolve(id) {
    id = stripNs(id);
    if (this.resolved.has(id)) return this.resolved.get(id);
    const chain = [];
    let cur = id;
    const seen = new Set();
    while (cur) {
      if (cur === 'builtin/generated') { chain.push({ __generated: true }); break; }
      if (seen.has(cur)) throw new Error(`model parent cycle at ${cur}`);
      seen.add(cur);
      const j = this.loadRaw(cur);
      chain.push(j);
      cur = j.parent ? stripNs(j.parent) : null;
    }
    const textures = {};
    let elements = null, ao = null, guiLight = null, generated = false;
    const display = {};
    for (let i = chain.length - 1; i >= 0; i--) {
      const j = chain[i];
      if (j.__generated) { generated = true; continue; }
      Object.assign(textures, j.textures || {});
      if (j.display) Object.assign(display, j.display);
    }
    for (const j of chain) {
      if (j.__generated) continue;
      if (elements === null && j.elements) elements = j.elements;
      if (ao === null && j.ambientocclusion !== undefined) ao = j.ambientocclusion;
      if (guiLight === null && j.gui_light !== undefined) guiLight = j.gui_light;
    }
    const r = { id, textures, elements: elements || [], ao: ao === null ? true : ao, guiLight: guiLight || 'side', display, generated };
    this.resolved.set(id, r);
    return r;
  }
}

/** Resolve '#ref' through a texture map. Returns {sprite, forceTranslucent} or null if unresolved. */
export function resolveTexture(textures, ref) {
  let v = ref;
  let force = false;
  for (let guard = 0; guard < 32; guard++) {
    if (v && typeof v === 'object') { force = force || !!v.force_translucent; v = v.sprite; continue; }
    if (typeof v !== 'string') return null;
    if (v.startsWith('#')) { v = textures[v.slice(1)]; continue; }
    return { sprite: stripNs(v), forceTranslucent: force };
  }
  throw new Error(`texture reference loop for ${JSON.stringify(ref)}`);
}

/** BlockElement default UV per face (vanilla uvsByDirection). */
export function defaultUv(dir, from, to) {
  switch (dir) {
    case 'down': return [from[0], 16 - to[2], to[0], 16 - from[2]];
    case 'up': return [from[0], from[2], to[0], to[2]];
    case 'north': return [16 - to[0], 16 - to[1], 16 - from[0], 16 - from[1]];
    case 'south': return [from[0], 16 - to[1], to[0], 16 - from[1]];
    case 'west': return [from[2], 16 - to[1], to[2], 16 - from[1]];
    case 'east': return [16 - to[2], 16 - to[1], 16 - from[2], 16 - from[1]];
  }
  throw new Error('bad dir ' + dir);
}

export const DIRS = ['down', 'up', 'north', 'south', 'west', 'east'];

/** Does a blockstate variant key "a=b,c=d" match the state's values? */
export function variantMatches(key, state) {
  if (key === '' || key === 'normal') return true;
  for (const kv of key.split(',')) {
    const [k, v] = kv.split('=');
    if (state[k] !== v) return false;
  }
  return true;
}

/** Evaluate a multipart "when" condition. */
export function whenMatches(when, state) {
  if (!when) return true;
  if (when.OR) return when.OR.some((w) => whenMatches(w, state));
  if (when.AND) return when.AND.every((w) => whenMatches(w, state));
  for (const [k, v] of Object.entries(when)) {
    const vals = String(v).split('|');
    let ok = vals.includes(state[k]);
    if (String(v).startsWith('!')) ok = !String(v).slice(1).split('|').includes(state[k]);
    if (!ok) return false;
  }
  return true;
}

/** Cartesian enumeration of states, properties sorted by name, last varying fastest (vanilla StateDefinition). */
export function enumerateStates(props) {
  const names = Object.keys(props).sort();
  let states = [{}];
  for (const n of names) {
    const next = [];
    for (const s of states) for (const v of props[n]) next.push({ ...s, [n]: v });
    states = next;
  }
  return { names, states };
}
