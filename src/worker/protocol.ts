// Messages between main thread, world worker and generation workers.
import type { BlocksJson, ModelsJson } from '../assets/types';
import type { RGBAImage } from '../assets/png';
import type { WorldType, Dimension } from '../worldgen/generator';

export interface WorldConfig {
  seed: string; // bigint as decimal string
  type: WorldType; singleBiome?: string; structures: boolean; bonusChest: boolean;
  flatPreset?: string;
  dimension?: Dimension;
}

export interface StaticData {
  blocks: BlocksJson; models: ModelsJson; worldgen: Record<string, any>; tags: Record<string, any>;
  grass: RGBAImage; foliage: RGBAImage; dryFoliage: RGBAImage;
  spriteSlots: Uint32Array; spriteNames: string[];
  structureBase: string; // URL prefix for structure .nbt files
}

export type ToWorld =
  | { type: 'init'; data: StaticData; config: WorldConfig; worldId: string; genWorkers: number; smoothLighting: boolean; biomeBlend: number }
  | { type: 'view'; x: number; y: number; z: number; renderDistance: number }
  | { type: 'setBlock'; x: number; y: number; z: number; state: number }
  | { type: 'save' }
  | { type: 'options'; smoothLighting: boolean; biomeBlend: number };

export type FromWorld =
  | { type: 'ready' }
  | { type: 'chunk'; cx: number; cz: number; states: Uint16Array; sky: Uint8Array; block: Uint8Array; biomes: Uint8Array }
  | { type: 'sectionLight'; cx: number; cz: number; sy: number; sky: Uint8Array; block: Uint8Array }
  | { type: 'mesh'; key: number; sx: number; sy: number; sz: number; layers: [ArrayBuffer, ArrayBuffer, ArrayBuffer]; quads: [number, number, number]; centers: Float32Array; vis: number }
  | { type: 'unload'; cx: number; cz: number; keys: number[] }
  | { type: 'progress'; loaded: number; pending: number }
  | { type: 'saved' }
  | { type: 'error'; message: string };

export type ToGen =
  | { type: 'init'; worldgen: Record<string, any>; tags: Record<string, any>; blocks: BlocksJson; grass: RGBAImage; foliage: RGBAImage; dryFoliage: RGBAImage; config: WorldConfig; structureBase: string }
  | { type: 'proto'; id: number; cx: number; cz: number }
  | { type: 'decorate'; id: number; cx: number; cz: number; protos: { cx: number; cz: number; states: Uint16Array; biomes: Uint8Array }[] };

export type FromGen =
  | { type: 'ready' }
  | { type: 'proto'; id: number; cx: number; cz: number; states: Uint16Array; biomes: Uint8Array }
  | { type: 'decorated'; id: number; cx: number; cz: number; writes: { key: string; w: Uint32Array }[] }
  | { type: 'error'; id: number; message: string };

export const sectionKey = (cx: number, sy: number, cz: number) => ((cx + 32768) * 65536 + (cz + 32768)) * 32 + (sy + 4);
