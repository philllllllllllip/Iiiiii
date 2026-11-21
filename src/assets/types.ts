// Shapes of the files produced by scripts/extract-assets.mjs.
export type Dir = 'down' | 'up' | 'north' | 'south' | 'west' | 'east';

export interface AtlasSprite {
  w: number; h: number;
  alpha: 'solid' | 'cutout' | 'translucent';
  frames: [number, number][];
  anim?: { seq: [number, number][]; interpolate: boolean };
  mipmap?: string;
  alphaCutoffBias?: number;
  gui?: { type: 'stretch' | 'tile' | 'nine_slice'; width?: number; height?: number;
    border?: number | { left: number; top: number; right: number; bottom: number }; stretch_inner?: boolean };
}
export interface AtlasJson { width: number; height: number; padding: number; sprites: Record<string, AtlasSprite> }

export interface ModelFace { uv: [number, number, number, number]; tex: number; cull?: Dir; rot?: number; tint?: number; translucent?: boolean }
export interface ModelElement {
  from: [number, number, number]; to: [number, number, number];
  rotation?: { origin: [number, number, number]; axis?: 'x' | 'y' | 'z'; angle?: number; rescale?: boolean; x?: number; y?: number; z?: number };
  shade?: boolean; light?: number; shadeDir?: Dir;
  faces: Partial<Record<Dir, ModelFace>>;
}
export interface Model {
  id: string; ao: boolean; gui: 'side' | 'front';
  elements: ModelElement[]; layers?: number[]; display?: Record<string, { rotation?: number[]; translation?: number[]; scale?: number[] }>;
  particle?: number; layer: 0 | 1 | 2; fullCube: boolean;
}
export interface ModelsJson { sprites: string[]; models: Model[] }

export interface PartChoice { m: number; x?: number; y?: number; z?: number; uvlock?: boolean; w?: number }
export interface BlockJson { name: string; props: [string, string[]][]; first: number; count: number; def: number }
export interface BlocksJson { blocks: BlockJson[]; states: number[][]; parts: PartChoice[][] }

export interface FontGlyph {
  space?: boolean; advance: number;
  sheet?: number; x?: number; y?: number; w?: number; h?: number; scale?: number; ascent?: number; unihex?: boolean;
}
export interface FontJson { sheets: { file: string; width: number; height: number }[]; glyphs: Record<string, FontGlyph> }

export interface Manifest { version: string; releaseTime: string; worldVersion: number; counts: Record<string, number> }
