// Block sprites -> TEXTURE_2D_ARRAYs (one per sprite size), sourced from the packed atlas.
// Mip chains follow the sprite's 26.3 mipmap_strategy. Animated sprites re-upload their current
// frame into their layer on the 20 tps tick (SpriteContents.AnimatedTexture), interpolating when the
// .mcmeta asks for it.
import type { RGBAImage } from '../assets/png';
import type { AtlasJson, AtlasSprite } from '../assets/types';

export const MIP_LEVELS = 4;
const SIZES = [16, 32, 64];

const pow22 = new Float32Array(256).map((_, i) => Math.pow(i / 255, 2.2));
const unpow = (v: number) => Math.round(Math.pow(v, 1 / 2.2) * 255);

/** One mip reduction step of a w*h RGBA image. */
export function reduce(src: Uint8Array, w: number, h: number, strategy: string, bias: number): Uint8Array {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    let a = 0, r = 0, g = 0, b = 0, opaque = 0, cov = 0;
    for (let k = 0; k < 4; k++) {
      const sx = Math.min(w - 1, x * 2 + (k & 1)), sy = Math.min(h - 1, y * 2 + (k >> 1));
      const o = (sy * w + sx) * 4;
      const al = src[o + 3];
      cov += al / 255;
      a += pow22[al];
      if (al !== 0) { r += pow22[src[o]]; g += pow22[src[o + 1]]; b += pow22[src[o + 2]]; opaque++; }
      else if (strategy === 'dark_cutout') { opaque++; }
    }
    const o = (y * nw + x) * 4;
    if (opaque) { out[o] = unpow(r / opaque); out[o + 1] = unpow(g / opaque); out[o + 2] = unpow(b / opaque); }
    switch (strategy) {
      case 'mean': out[o + 3] = unpow(a / 4); break;
      case 'strict_cutout': out[o + 3] = cov / 4 >= 0.5 - bias ? 255 : 0; break;
      case 'cutout': case 'dark_cutout': {
        let al = unpow(a / 4);
        if (al < 96 - bias * 255) al = 0;
        out[o + 3] = al; break;
      }
      default: { // auto: vanilla alphaBlend — cutout-style if the sprite has any transparency
        let al = unpow(a / 4);
        const any0 = cov < 4;
        if (any0 && al < 96) al = 0;
        out[o + 3] = al;
      }
    }
  }
  return out;
}

interface Anim { name: string; arr: number; layer: number; sprite: AtlasSprite; frames: Uint8Array[]; seq: [number, number][]; interpolate: boolean; pos: number; sub: number; total: number }

export class BlockTextures {
  readonly arrays: (WebGLTexture | null)[] = [null, null, null];
  readonly slotOf = new Map<string, number>(); // sprite name -> (arr << 16 | layer)
  private anims: Anim[] = [];
  private layerCount = [0, 0, 0];

  constructor(readonly gl: WebGL2RenderingContext, readonly atlas: AtlasJson, readonly image: RGBAImage) {
    const entries = Object.entries(atlas.sprites);
    const pending: [string, AtlasSprite, number, number][] = [];
    for (const [name, sp] of entries) {
      const arr = SIZES.findIndex((s) => sp.w <= s && sp.h <= s);
      if (arr < 0) throw new Error(`sprite ${name} ${sp.w}x${sp.h} exceeds 64px`);
      pending.push([name, sp, arr, this.layerCount[arr]++]);
      this.slotOf.set(name, (arr << 16) | (this.layerCount[arr] - 1));
    }
    for (let a = 0; a < 3; a++) {
      if (!this.layerCount[a]) continue;
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, MIP_LEVELS + 1, gl.RGBA8, SIZES[a], SIZES[a], this.layerCount[a]);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, MIP_LEVELS);
      this.arrays[a] = t;
    }
    for (const [name, sp, arr, layer] of pending) {
      const frames = sp.frames.map(([fx, fy]) => this.extract(fx, fy, sp.w, sp.h, SIZES[arr]));
      this.upload(arr, layer, frames[sp.anim ? sp.anim.seq[0][0] : 0], sp, SIZES[arr]);
      if (sp.anim) {
        const total = sp.anim.seq.reduce((s, [, t]) => s + t, 0);
        this.anims.push({ name, arr, layer, sprite: sp, frames, seq: sp.anim.seq, interpolate: sp.anim.interpolate, pos: 0, sub: 0, total });
      }
    }
  }

  /** Copy a sprite frame out of the atlas, nearest-replicated into the layer size when smaller. */
  private extract(fx: number, fy: number, w: number, h: number, size: number): Uint8Array {
    const out = new Uint8Array(size * size * 4);
    const img = this.image;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const sx = Math.floor((x * w) / size), sy = Math.floor((y * h) / size);
      const s = ((fy + sy) * img.width + fx + sx) * 4, d = (y * size + x) * 4;
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = img.data[s + 3];
    }
    return out;
  }

  private upload(arr: number, layer: number, px: Uint8Array, sp: AtlasSprite, size: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.arrays[arr]);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    let cur = px, w = size;
    const strategy = sp.mipmap ?? 'auto';
    for (let l = 0; l <= MIP_LEVELS; l++) {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, l, 0, 0, layer, w, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, cur);
      if (l < MIP_LEVELS) { cur = reduce(cur, w, w, strategy, sp.alphaCutoffBias ?? 0) as Uint8Array<ArrayBuffer>; w = Math.max(1, w >> 1); }
    }
  }

  /** Advance animations by one game tick. */
  tick(): void {
    for (const a of this.anims) {
      a.sub++;
      const [, time] = a.seq[a.pos];
      let changed = false;
      if (a.sub >= time) { a.sub = 0; a.pos = (a.pos + 1) % a.seq.length; changed = true; }
      if (a.interpolate) {
        const cur = a.frames[a.seq[a.pos][0]], next = a.frames[a.seq[(a.pos + 1) % a.seq.length][0]];
        const f = a.sub / a.seq[a.pos][1];
        const mix = new Uint8Array(cur.length);
        for (let i = 0; i < cur.length; i++) mix[i] = Math.round(cur[i] * (1 - f) + next[i] * f);
        this.upload(a.arr, a.layer, mix, a.sprite, SIZES[a.arr]);
      } else if (changed) {
        this.upload(a.arr, a.layer, a.frames[a.seq[a.pos][0]], a.sprite, SIZES[a.arr]);
      }
    }
  }

  /** Slot table for the mesher, indexed by models.json sprite id. Non-block sprites map to missingno. */
  slotTable(spriteNames: string[]): Uint32Array {
    const miss = this.slotOf.get('missingno')!;
    return Uint32Array.from(spriteNames.map((n) => this.slotOf.get(n) ?? miss));
  }
}
