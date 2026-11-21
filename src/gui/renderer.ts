// GuiGraphics equivalent: batched textured/colored quads in GUI pixel space (ortho, integer GUI scale),
// gui sprites with the atlas' nine_slice / tile / stretch scaling, standalone textures, and text.
import { Program } from '../gl/util';
import type { AtlasJson, FontJson, FontGlyph } from '../assets/types';
import type { RGBAImage } from '../assets/png';
import { loadPng } from '../assets/bundle';

const VS = `#version 300 es
layout(location=0) in vec2 Position; layout(location=1) in vec2 UV0; layout(location=2) in vec4 Color;
uniform vec2 ScreenSize; out vec2 uv; out vec4 col;
void main() { gl_Position = vec4(Position.x / ScreenSize.x * 2.0 - 1.0, 1.0 - Position.y / ScreenSize.y * 2.0, 0.0, 1.0); uv = UV0; col = Color; }`;
const FS = `#version 300 es
precision highp float; uniform sampler2D Sampler0; uniform float Textured;
in vec2 uv; in vec4 col; out vec4 fragColor;
void main() { vec4 c = Textured > 0.5 ? texture(Sampler0, uv) * col : col; if (c.a == 0.0) discard; fragColor = c; }`;

export interface Tex { tex: WebGLTexture; w: number; h: number }

/** Vanilla text formatting colours (ChatFormatting). */
export const COLORS: Record<string, number> = {
  '0': 0x000000, '1': 0x0000aa, '2': 0x00aa00, '3': 0x00aaaa, '4': 0xaa0000, '5': 0xaa00aa, '6': 0xffaa00, '7': 0xaaaaaa,
  '8': 0x555555, '9': 0x5555ff, a: 0x55ff55, b: 0x55ffff, c: 0xff5555, d: 0xff55ff, e: 0xffff55, f: 0xffffff,
};

export class GuiRenderer {
  private prog: Program;
  private vao: WebGLVertexArrayObject; private vbo: WebGLBuffer;
  private data = new Float32Array(8 * 6 * 4096); private n = 0;
  private curTex: WebGLTexture | null = null; private curTextured = true;
  atlasTex: Tex; fontTex: Tex[];
  private textures = new Map<string, Tex | Promise<Tex>>();
  scale = 2; width = 0; height = 0; // GUI-space size
  /** 2D pose (PoseStack): x' = a*x + c*y + e, y' = b*x + d*y + f */
  private pose = [1, 0, 0, 1, 0, 0];
  transformed(ax: number, ay: number, deg: number, sc: number, fn: () => void): void {
    const saved = this.pose;
    const r = (deg * Math.PI) / 180, co = Math.cos(r) * sc, si = Math.sin(r) * sc;
    const [a, b, c, d, e, f] = saved;
    // saved * translate(ax, ay) * rotate * scale
    this.pose = [a * co + c * si, b * co + d * si, a * -si + c * co, b * -si + d * co, a * ax + c * ay + e, b * ax + d * ay + f];
    try { fn(); } finally { this.pose = saved; }
  }
  private tx(x: number, y: number): number { const p = this.pose; return p[0] * x + p[2] * y + p[4]; }
  private ty(x: number, y: number): number { const p = this.pose; return p[1] * x + p[3] * y + p[5]; }
  private pxW = 0; private pxH = 0;

  constructor(readonly gl: WebGL2RenderingContext, readonly atlas: AtlasJson, atlasImg: RGBAImage, readonly font: FontJson, fontImgs: RGBAImage[]) {
    this.prog = new Program(gl, VS, FS, 'gui');
    this.vao = gl.createVertexArray()!; this.vbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
    gl.bindVertexArray(null);
    this.atlasTex = this.upload(atlasImg);
    this.fontTex = fontImgs.map((i) => this.upload(i));
  }

  upload(img: RGBAImage): Tex {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return { tex: t, w: img.width, h: img.height };
  }

  /** A standalone texture from public/gen/textures (loaded on first use; draws nothing until ready). */
  texture(path: string): Tex | null {
    const t = this.textures.get(path);
    if (t && !(t instanceof Promise)) return t;
    if (!t) this.textures.set(path, loadPng('textures/' + path).then((img) => { const tx = this.upload(img); this.textures.set(path, tx); return tx; }));
    return null;
  }
  async preload(paths: string[]): Promise<void> { await Promise.all(paths.map((p) => { this.texture(p); return this.textures.get(p); })); }

  /** Window.calculateScale: largest scale <= requested (0 = auto) keeping >= 320x240 GUI pixels. */
  static calculateScale(guiScale: number, w: number, h: number): number {
    let i = 1;
    while (i !== guiScale && i < w && i < h && w / (i + 1) >= 320 && h / (i + 1) >= 240) i++;
    return i;
  }

  begin(pxW: number, pxH: number, guiScale: number): void {
    this.pxW = pxW; this.pxH = pxH;
    this.scale = GuiRenderer.calculateScale(guiScale, pxW, pxH);
    this.width = Math.ceil(pxW / this.scale); this.height = Math.ceil(pxH / this.scale);
    const gl = this.gl;
    gl.viewport(0, 0, pxW, pxH);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  flush(): void {
    if (!this.n) return;
    const gl = this.gl;
    const p = this.prog.use();
    p.v2('ScreenSize', this.pxW / this.scale, this.pxH / this.scale);
    p.f('Textured', this.curTextured ? 1 : 0);
    if (this.curTex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.curTex); p.i('Sampler0', 0); }
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, this.n * 8), gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, this.n);
    gl.bindVertexArray(null);
    this.n = 0;
  }

  private quad(tex: WebGLTexture | null, x0: number, y0: number, x1: number, y1: number, u0: number, v0: number, u1: number, v1: number, c: number[]): void {
    const textured = tex !== null;
    if (this.curTex !== tex || this.curTextured !== textured || this.n + 6 > this.data.length / 8) { this.flush(); this.curTex = tex; this.curTextured = textured; }
    const d = this.data; let o = this.n * 8;
    const put = (x: number, y: number, u: number, v: number) => { d[o++] = this.tx(x, y); d[o++] = this.ty(x, y); d[o++] = u; d[o++] = v; d[o++] = c[0]; d[o++] = c[1]; d[o++] = c[2]; d[o++] = c[3]; };
    put(x0, y0, u0, v0); put(x0, y1, u0, v1); put(x1, y1, u1, v1); put(x1, y1, u1, v1); put(x1, y0, u1, v0); put(x0, y0, u0, v0);
    this.n += 6;
  }

  fill(x0: number, y0: number, x1: number, y1: number, argb: number): void {
    this.quad(null, x0, y0, x1, y1, 0, 0, 0, 0, argbToRgba(argb));
  }
  fillGradient(x0: number, y0: number, x1: number, y1: number, top: number, bottom: number): void {
    const a = argbToRgba(top), b = argbToRgba(bottom);
    if (this.curTex !== null || this.curTextured || this.n + 6 > this.data.length / 8) { this.flush(); this.curTex = null; this.curTextured = false; }
    const d = this.data; let o = this.n * 8;
    const put = (x: number, y: number, c: number[]) => { d[o++] = this.tx(x, y); d[o++] = this.ty(x, y); d[o++] = 0; d[o++] = 0; d[o++] = c[0]; d[o++] = c[1]; d[o++] = c[2]; d[o++] = c[3]; };
    put(x0, y0, a); put(x0, y1, b); put(x1, y1, b); put(x1, y1, b); put(x1, y0, a); put(x0, y0, a);
    this.n += 6;
  }

  /** Blit a region (u,v,w,h in texels) of a texture to x,y with size dw,dh. */
  blit(t: Tex, x: number, y: number, dw: number, dh: number, u: number, v: number, w: number, h: number, color = 0xffffffff): void {
    this.quad(t.tex, x, y, x + dw, y + dh, u / t.w, v / t.h, (u + w) / t.w, (v + h) / t.h, argbToRgba(color));
  }

  /** GuiGraphics.blit with a logical texture size (vanilla passes textureWidth/Height explicitly). */
  blitL(t: Tex, x: number, y: number, dw: number, dh: number, u: number, v: number, w: number, h: number, texW: number, texH: number, color = 0xffffffff): void {
    this.quad(t.tex, x, y, x + dw, y + dh, u / texW, v / texH, (u + w) / texW, (v + h) / texH, argbToRgba(color));
  }

  /** GuiGraphics.blitSprite with the sprite's scaling metadata. */
  sprite(name: string, x: number, y: number, w: number, h: number, color = 0xffffffff, frame = 0): void {
    const sp = this.atlas.sprites[name];
    if (!sp) throw new Error('missing gui sprite ' + name);
    const [ax, ay] = sp.frames[Math.min(frame, sp.frames.length - 1)];
    const at = this.atlasTex;
    const g = sp.gui;
    if (!g || g.type === 'stretch' || (w === sp.w && h === sp.h && g.type !== 'tile')) { this.blit(at, x, y, w, h, ax, ay, sp.w, sp.h, color); return; }
    if (g.type === 'tile') { this.tile(ax, ay, g.width ?? sp.w, g.height ?? sp.h, x, y, w, h, color); return; }
    // nine slice
    const b = typeof g.border === 'number' ? { left: g.border, top: g.border, right: g.border, bottom: g.border } : g.border!;
    const sw = sp.w, sh = sp.h;
    const l = Math.min(b.left, w / 2), r = Math.min(b.right, w / 2), t = Math.min(b.top, h / 2), bt = Math.min(b.bottom, h / 2);
    const cw = sw - b.left - b.right, ch = sh - b.top - b.bottom;
    const piece = (dx: number, dy: number, dw: number, dh: number, sx: number, sy: number, pw: number, ph: number, stretch: boolean) => {
      if (dw <= 0 || dh <= 0) return;
      if (stretch || g.stretch_inner) this.blit(at, x + dx, y + dy, dw, dh, ax + sx, ay + sy, pw, ph, color);
      else this.tile(ax + sx, ay + sy, pw, ph, x + dx, y + dy, dw, dh, color);
    };
    piece(0, 0, l, t, 0, 0, l, t, true);
    piece(w - r, 0, r, t, sw - r, 0, r, t, true);
    piece(0, h - bt, l, bt, 0, sh - bt, l, bt, true);
    piece(w - r, h - bt, r, bt, sw - r, sh - bt, r, bt, true);
    piece(l, 0, w - l - r, t, b.left, 0, cw, t, false);
    piece(l, h - bt, w - l - r, bt, b.left, sh - bt, cw, bt, false);
    piece(0, t, l, h - t - bt, 0, b.top, l, ch, false);
    piece(w - r, t, r, h - t - bt, sw - r, b.top, r, ch, false);
    piece(l, t, w - l - r, h - t - bt, b.left, b.top, cw, ch, false);
  }
  /** Tile a source region over a destination rect (GuiGraphics.blitTiledSprite). */
  private tile(sx: number, sy: number, sw: number, sh: number, x: number, y: number, w: number, h: number, color: number): void {
    for (let dy = 0; dy < h; dy += sh) for (let dx = 0; dx < w; dx += sw) {
      const tw = Math.min(sw, w - dx), th = Math.min(sh, h - dy);
      this.blit(this.atlasTex, x + dx, y + dy, tw, th, sx, sy, tw, th, color);
    }
  }
  /** Sprite drawn with a fraction cut (e.g. XP bar progress): draws [0, w) x [0, h) of a sprite at size. */
  spritePart(name: string, x: number, y: number, w: number, h: number): void {
    const sp = this.atlas.sprites[name];
    const [ax, ay] = sp.frames[0];
    this.blit(this.atlasTex, x, y, w, h, ax, ay, w, h);
  }

  // ------------------------------------------------------------------ text
  glyph(cp: number): FontGlyph | undefined { return this.font.glyphs[cp]; }
  /** StringSplitter width (ignoring formatting codes). */
  textWidth(s: string): number {
    let w = 0, bold = false;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '§' && i + 1 < s.length) { const c = s[++i].toLowerCase(); if (c === 'l') bold = true; else if (c in COLORS || c === 'r') bold = false; continue; }
      const cp = s.codePointAt(i)!; if (cp > 0xffff) i++;
      const g = this.font.glyphs[cp];
      w += (g ? g.advance : 6) + (bold ? 1 : 0);
    }
    return w;
  }
  /** Font.drawInBatch: optional drop shadow (1px offset, colour * 0.25). Returns end x. */
  text(s: string, x: number, y: number, color = 0xffffffff, shadow = true): number {
    if ((color >>> 24) === 0) color |= 0xff000000;
    if (shadow) this.textRun(s, x + 1, y + 1, shadowColor(color), true);
    return this.textRun(s, x, y, color, false);
  }
  centered(s: string, cx: number, y: number, color = 0xffffffff, shadow = true): void { this.text(s, cx - this.textWidth(s) / 2, y, color, shadow); }

  private textRun(s: string, x: number, y: number, color: number, isShadow: boolean): number {
    let cur = color, bold = false, italic = false;
    const base = color;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '§' && i + 1 < s.length) {
        const c = s[++i].toLowerCase();
        if (c in COLORS) { const rgb = COLORS[c]; cur = (base & 0xff000000) | rgb; if (isShadow) cur = shadowColor(cur); bold = false; italic = false; }
        else if (c === 'l') bold = true; else if (c === 'o') italic = true; else if (c === 'r') { cur = isShadow ? base : base; bold = false; italic = false; }
        continue;
      }
      const cp = s.codePointAt(i)!; if (cp > 0xffff) i++;
      const g = this.font.glyphs[cp];
      if (!g) { // missing glyph: vanilla draws a box outline (6 advance)
        this.fill(x, y, x + 5, y + 8, cur & 0x00ffffff | 0x40000000);
        x += 6; continue;
      }
      if (!g.space) {
        const t = this.fontTex[g.sheet!];
        const scale = g.scale!;
        const top = y + (g.unihex ? 0 : 7 - g.ascent!) ;
        const dw = g.w! * scale, dh = g.h! * scale;
        const skew = italic ? 1 : 0;
        this.glyphQuad(t, x, top, dw, dh, g.x!, g.y!, g.w!, g.h!, cur, skew);
        if (bold) this.glyphQuad(t, x + 1, top, dw, dh, g.x!, g.y!, g.w!, g.h!, cur, skew);
      }
      x += g.advance + (bold ? 1 : 0);
    }
    return x;
  }
  private glyphQuad(t: Tex, x: number, y: number, dw: number, dh: number, u: number, v: number, w: number, h: number, color: number, skew: number): void {
    if (!skew) { this.blit(t, x, y, dw, dh, u, v, w, h, color); return; }
    // italic: shear by 1px over the glyph height
    const c = argbToRgba(color);
    if (this.curTex !== t.tex || !this.curTextured || this.n + 6 > this.data.length / 8) { this.flush(); this.curTex = t.tex; this.curTextured = true; }
    const d = this.data; let o = this.n * 8;
    const u0 = u / t.w, v0 = v / t.h, u1 = (u + w) / t.w, v1 = (v + h) / t.h;
    const put = (px: number, py: number, uu: number, vv: number) => { d[o++] = this.tx(px, py); d[o++] = this.ty(px, py); d[o++] = uu; d[o++] = vv; d[o++] = c[0]; d[o++] = c[1]; d[o++] = c[2]; d[o++] = c[3]; };
    put(x + skew, y, u0, v0); put(x, y + dh, u0, v1); put(x + dw, y + dh, u1, v1); put(x + dw, y + dh, u1, v1); put(x + dw + skew, y, u1, v0); put(x + skew, y, u0, v0);
    this.n += 6;
  }
  /** Font.split for word wrapping. */
  wrap(s: string, width: number): string[] {
    const out: string[] = [];
    for (const para of s.split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const cand = line ? line + ' ' + word : word;
        if (this.textWidth(cand) > width && line) { out.push(line); line = word; } else line = cand;
      }
      out.push(line);
    }
    return out;
  }
}

export function argbToRgba(c: number): number[] {
  return [((c >>> 16) & 255) / 255, ((c >>> 8) & 255) / 255, (c & 255) / 255, ((c >>> 24) & 255) / 255];
}
/** ARGB.scaleRGB(color, 0.25) keeping alpha */
export function shadowColor(c: number): number {
  const a = c >>> 24, r = ((c >>> 16) & 255) >> 2, g = ((c >>> 8) & 255) >> 2, b = (c & 255) >> 2;
  return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
}
