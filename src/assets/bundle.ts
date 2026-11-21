// Loads the generated asset bundle. Missing files are fatal: there are no placeholder fallbacks.
import { decodePng, type RGBAImage } from './png';
import type { AtlasJson, BlocksJson, FontJson, Manifest, ModelsJson } from './types';

export const GEN = (import.meta.env.BASE_URL ?? '/') + 'gen/';

export class AssetError extends Error {}

async function fetchOk(path: string): Promise<Response> {
  let res: Response;
  try { res = await fetch(GEN + path); } catch (e) { throw new AssetError(`asset fetch failed: ${path} (${e})`); }
  if (!res.ok) throw new AssetError(`missing asset ${path} (HTTP ${res.status}). Run \`npm run assets\`.`);
  return res;
}
export async function loadJson<T>(path: string): Promise<T> {
  const res = await fetchOk(path);
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/html')) throw new AssetError(`missing asset ${path} (dev server returned HTML). Run \`npm run assets\`.`);
  return res.json() as Promise<T>;
}
export async function loadPng(path: string): Promise<RGBAImage> {
  const res = await fetchOk(path);
  return decodePng(new Uint8Array(await res.arrayBuffer()));
}
export async function loadText(path: string): Promise<string> { return (await fetchOk(path)).text(); }
export async function loadBytes(path: string): Promise<ArrayBuffer> { return (await fetchOk(path)).arrayBuffer(); }

export interface Bundle {
  manifest: Manifest;
  blocks: BlocksJson;
  models: ModelsJson;
  blockAtlas: AtlasJson; blockAtlasImage: RGBAImage;
  itemAtlas: AtlasJson; itemAtlasImage: RGBAImage;
  guiAtlas: AtlasJson; guiAtlasImage: RGBAImage;
  particleAtlas: AtlasJson; particleAtlasImage: RGBAImage;
  celestialAtlas: AtlasJson; celestialAtlasImage: RGBAImage;
  font: FontJson; fontSheets: RGBAImage[];
  lang: Record<string, string>;
  grassColormap: RGBAImage; foliageColormap: RGBAImage; dryFoliageColormap: RGBAImage;
  timelines: Record<string, any>;
  dimensionTypes: Record<string, any>;
  worldgen: Record<string, any>;
}

export async function loadBundle(progress?: (done: number, total: number) => void): Promise<Bundle> {
  const tasks: Record<string, Promise<unknown>> = {
    manifest: loadJson('manifest.json'),
    blocks: loadJson('blocks.json'),
    models: loadJson('models.json'),
    blockAtlas: loadJson('atlas/blocks.json'), blockAtlasImage: loadPng('atlas/blocks.png'),
    itemAtlas: loadJson('atlas/items.json'), itemAtlasImage: loadPng('atlas/items.png'),
    guiAtlas: loadJson('atlas/gui.json'), guiAtlasImage: loadPng('atlas/gui.png'),
    particleAtlas: loadJson('atlas/particles.json'), particleAtlasImage: loadPng('atlas/particles.png'),
    celestialAtlas: loadJson('atlas/celestials.json'), celestialAtlasImage: loadPng('atlas/celestials.png'),
    font: loadJson('font.json'),
    lang: loadJson('lang/en_us.json'),
    grassColormap: loadPng('textures/colormap/grass.png'),
    foliageColormap: loadPng('textures/colormap/foliage.png'),
    dryFoliageColormap: loadPng('textures/colormap/dry_foliage.png'),
    timelines: loadJson('data/timelines.json'),
    dimensionTypes: loadJson('data/dimension_types.json'),
    worldgen: loadJson('data/worldgen.json'),
  };
  const keys = Object.keys(tasks);
  let done = 0;
  for (const k of keys) tasks[k].then(() => progress?.(++done, keys.length + 1));
  const vals = await Promise.all(keys.map((k) => tasks[k]));
  const b = Object.fromEntries(keys.map((k, i) => [k, vals[i]])) as unknown as Bundle;
  if (b.manifest.version !== '26.3') throw new AssetError(`asset bundle is ${b.manifest.version}, expected 26.3`);
  b.fontSheets = await Promise.all(b.font.sheets.map((s) => loadPng(s.file.startsWith('textures/') ? s.file : s.file)));
  progress?.(keys.length + 1, keys.length + 1);
  return b;
}
