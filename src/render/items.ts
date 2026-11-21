// ItemRenderer: resolves 26.3 item definitions (items/*.json model trees) to baked models and draws them
// in world (dropped items, held item) or GUI contexts with the model's display transforms.
//  * element models: baked with the block FaceBakery port, block texture arrays
//  * item/generated: ItemModelGenerator extrusion (front/back + per-pixel edge faces), item atlas
// Lighting follows core/item.vsh (minecraft_mix_light with two directional lights).
import { Program, FOG_GLSL } from '../gl/util';
import { bakeChoice, DIR_VEC } from '../mesh/bake';
import type { Model, ModelsJson, AtlasJson } from '../assets/types';
import type { RGBAImage } from '../assets/png';
import type { BlockTextures } from './blocktextures';
import { mul, rotX, rotY, rotZ, translate, scale, type M4 } from '../util/mat';
import type { FogParams } from './terrain';
import { setFog } from './terrain';

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 Position; layout(location=1) in vec2 UV0; layout(location=2) in float Layer;
layout(location=3) in vec3 Normal; layout(location=4) in vec4 Color;
uniform mat4 ProjMat; uniform mat4 ModelViewMat; uniform mat3 NormalMat;
uniform vec3 Light0_Direction; uniform vec3 Light1_Direction;
uniform vec2 LightUV; uniform sampler2D Sampler2; uniform float UseLightmap;
out float sphericalVertexDistance; out float cylindricalVertexDistance;
out vec4 vertexColor; out vec4 lightMapColor; out vec2 texCoord0; flat out float layer;
${FOG_GLSL}
void main() {
  vec4 p = ModelViewMat * vec4(Position, 1.0);
  gl_Position = ProjMat * p;
  sphericalVertexDistance = fog_spherical_distance(p.xyz);
  cylindricalVertexDistance = fog_cylindrical_distance(p.xyz);
  vec3 n = normalize(NormalMat * Normal);
  vec2 light = max(vec2(0.0), vec2(dot(Light0_Direction, n), dot(Light1_Direction, n)));
  float acc = min(1.0, (light.x + light.y) * 0.6 + 0.4);
  vertexColor = vec4(Color.rgb * acc, Color.a);
  lightMapColor = UseLightmap > 0.5 ? texture(Sampler2, clamp(LightUV / 256.0 + 0.5 / 16.0, vec2(0.5 / 16.0), vec2(15.5 / 16.0))) : vec4(1.0);
  texCoord0 = UV0; layer = Layer;
}`;
const FS = `#version 300 es
precision highp float; precision highp sampler2DArray;
uniform sampler2DArray Tex16; uniform sampler2D ItemTex; uniform float UseArray; uniform vec4 ColorModulator; uniform float UseFog;
in float sphericalVertexDistance; in float cylindricalVertexDistance;
in vec4 vertexColor; in vec4 lightMapColor; in vec2 texCoord0; flat in float layer;
out vec4 fragColor;
${FOG_GLSL}
void main() {
  vec4 color = UseArray > 0.5 ? texture(Tex16, vec3(texCoord0, layer)) : texture(ItemTex, texCoord0);
  if (color.a < 0.1) discard;
  color *= vertexColor * ColorModulator;
  color *= lightMapColor;
  fragColor = UseFog > 0.5 ? apply_fog(color, sphericalVertexDistance, cylindricalVertexDistance, FogEnvironmentalStart, FogEnvironmentalEnd, FogRenderDistanceStart, FogRenderDistanceEnd, FogColor) : color;
}`;

export type DisplayContext = 'gui' | 'ground' | 'fixed' | 'head' | 'firstperson_righthand' | 'firstperson_lefthand' | 'thirdperson_righthand' | 'thirdperson_lefthand' | 'none';

interface GpuModel { vao: WebGLVertexArrayObject; count: number; useArray: boolean; display: Model['display']; gui: 'side' | 'front'; blockLike: boolean }

export class ItemRenderer {
  private prog: Program;
  private cache = new Map<string, GpuModel | null>();
  private itemTex: WebGLTexture;

  constructor(readonly gl: WebGL2RenderingContext, readonly models: ModelsJson, readonly itemDefs: Record<string, any>,
    readonly blockTex: BlockTextures, readonly itemAtlas: AtlasJson, itemImage: RGBAImage) {
    this.prog = new Program(gl, VS, FS, 'item');
    this.itemTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.itemTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, itemImage.width, itemImage.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, itemImage.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  /** Resolve the item definition tree to model indices + tints for a context (no components = defaults). */
  resolve(item: string, ctx: DisplayContext): { m: number; tints: number[] }[] {
    const def = this.itemDefs[item];
    if (!def) return [];
    const out: { m: number; tints: number[] }[] = [];
    const walk = (n: any) => {
      if (!n) return;
      const t = String(n.type).replace('minecraft:', '');
      switch (t) {
        case 'model': out.push({ m: n.modelIndex, tints: (n.tints ?? []).map((ti: any) => tintColor(ti)) }); break;
        case 'composite': for (const c of n.models) walk(c); break;
        case 'condition': walk(n.on_false); break;
        case 'select': {
          const prop = String(n.property).replace('minecraft:', '');
          const c = prop === 'display_context' ? n.cases.find((cs: any) => (Array.isArray(cs.when) ? cs.when : [cs.when]).includes(ctx)) : undefined;
          walk(c ? c.model : n.fallback ?? n.cases[0]?.model);
          break;
        }
        case 'range_dispatch': walk(n.fallback ?? n.entries?.[0]?.model); break;
        case 'special': if (n.base) { const bi = this.models.models.findIndex((m) => m.id === String(n.base).replace('minecraft:', '')); if (bi >= 0) out.push({ m: bi, tints: [] }); } break;
        case 'bundle/selected_item': case 'empty': break;
        default: break;
      }
    };
    walk(def.model);
    return out;
  }

  private build(mi: number, tints: number[]): GpuModel | null {
    const model = this.models.models[mi];
    const v: number[] = [];
    let useArray = true;
    const push = (x: number, y: number, z: number, u: number, vv: number, layer: number, n: number[], col: number) =>
      v.push(x, y, z, u, vv, layer, n[0], n[1], n[2], ((col >> 16) & 255) / 255, ((col >> 8) & 255) / 255, (col & 255) / 255, 1);
    if (model.layers && model.layers.length) {
      useArray = false;
      // ItemModelGenerator: per layer, a front (south) + back (north) quad and 1px edge quads
      model.layers.forEach((spriteId, li) => {
        const name = this.models.sprites[spriteId];
        const sp = this.itemAtlas.sprites[name];
        if (!sp) return;
        const [ax, ay] = sp.frames[0];
        const W = this.itemAtlas.width, H = this.itemAtlas.height;
        const u0 = ax / W, v0 = ay / H, du = sp.w / W, dv = sp.h / H;
        const col = tints[li] ?? 0xffffff;
        const z0 = 7.5 / 16, z1 = 8.5 / 16;
        const q = (p: number[][], uv: number[][], n: number[]) => { for (const i of [0, 1, 2, 2, 3, 0]) push(p[i][0], p[i][1], p[i][2], uv[i][0], uv[i][1], 0, n, col); };
        q([[0, 1, z1], [0, 0, z1], [1, 0, z1], [1, 1, z1]], [[u0, v0], [u0, v0 + dv], [u0 + du, v0 + dv], [u0 + du, v0]], [0, 0, 1]);
        q([[1, 1, z0], [1, 0, z0], [0, 0, z0], [0, 1, z0]], [[u0 + du, v0], [u0 + du, v0 + dv], [u0, v0 + dv], [u0, v0]], [0, 0, -1]);
        // edges from the sprite's alpha: one quad per transparent/opaque boundary pixel edge
        const img = this.itemImage!;
        const op = (px: number, py: number) => px >= 0 && py >= 0 && px < sp.w && py < sp.h && img.data[((ay + py) * W + ax + px) * 4 + 3] > 0;
        const pw = 1 / sp.w, ph = 1 / sp.h;
        for (let py = 0; py < sp.h; py++) for (let px = 0; px < sp.w; px++) {
          if (!op(px, py)) continue;
          const x0 = px * pw, x1 = x0 + pw, y1 = 1 - py * ph, y0 = y1 - ph;
          const cu = u0 + (px + 0.5) * pw * du, cv = v0 + (py + 0.5) * ph * dv;
          const uv = [[cu, cv], [cu, cv], [cu, cv], [cu, cv]];
          if (!op(px, py - 1)) q([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], uv, [0, 1, 0]);
          if (!op(px, py + 1)) q([[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], uv, [0, -1, 0]);
          if (!op(px - 1, py)) q([[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]], uv, [-1, 0, 0]);
          if (!op(px + 1, py)) q([[x1, y1, z1], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0]], uv, [1, 0, 0]);
        }
      });
    } else if (model.elements.length) {
      for (const q of bakeChoice(model, { m: mi })) {
        const slot = this.blockTex.slotOf.get(this.models.sprites[q.sprite]);
        if (slot === undefined || slot >> 16 !== 0) continue; // only 16px sprites are used by item element models
        const col = q.tint >= 0 ? (tints[q.tint] ?? 0xffffff) : 0xffffff;
        const n = DIR_VEC[q.dir];
        for (const i of [0, 1, 2, 2, 3, 0]) push(q.pos[i * 3], q.pos[i * 3 + 1], q.pos[i * 3 + 2], q.uv[i * 2], q.uv[i * 2 + 1], slot & 0xffff, n, col);
      }
    } else return null;
    const gl = this.gl;
    const vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    const S = 13 * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, S, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, S, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, S, 20);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, S, 24);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.FLOAT, false, S, 36);
    gl.bindVertexArray(null);
    return { vao, count: v.length / 13, useArray, display: model.display, gui: model.gui, blockLike: !!model.elements.length && !model.layers };
  }
  itemImage: RGBAImage | null = null;

  private gpu(mi: number, tints: number[]): GpuModel | null {
    const k = mi + ':' + tints.join(',');
    if (!this.cache.has(k)) this.cache.set(k, this.build(mi, tints));
    return this.cache.get(k)!;
  }

  /** ItemTransform for a display context, then the model's -0.5 centring. */
  transform(display: Model['display'], ctx: DisplayContext): M4 {
    const d = display?.[ctx];
    let m = translate(0, 0, 0);
    if (d) {
      const t = (d.translation ?? [0, 0, 0]).map((v) => Math.max(-80, Math.min(80, v)) / 16);
      const r = d.rotation ?? [0, 0, 0], s = d.scale ?? [1, 1, 1];
      const flip = ctx.endsWith('lefthand') ? -1 : 1;
      m = mul(translate(t[0] * flip, t[1], t[2]), mul(rotX(r[0]), mul(rotY(r[1] * flip), mul(rotZ(r[2] * flip), scale(s[0], s[1], s[2])))));
    }
    return mul(m, translate(-0.5, -0.5, -0.5));
  }

  /** Draw an item icon at GUI position (x, y) (16x16 slot). */
  drawGui(item: string, x: number, y: number, guiW: number, guiH: number): void {
    const gl = this.gl;
    const parts = this.resolve(item, 'gui');
    const flat = parts.every(({ m }) => this.models.models[m]?.gui === 'front' || !!this.models.models[m]?.layers);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // the GUI pose flips Y (scale 16,-16,16), which inverts winding: cull front-facing CW triangles instead
    gl.enable(gl.CULL_FACE); gl.frontFace(gl.CW);
    this.draw(item, 'gui', orthoGui(guiW, guiH), guiItemPose(x, y), null, null, null, flat ? GUI_LIGHTS_FLAT : GUI_LIGHTS_3D);
    gl.frontFace(gl.CCW); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
  }

  isBlockLike(item: string): boolean {
    for (const { m } of this.resolve(item, 'gui')) { const md = this.models.models[m]; if (md && md.elements.length && !md.layers) return true; }
    return false;
  }

  /**
   * Draw an item. `pose` maps item space (after display transform) to view space.
   * light: packed [block*16, sky*16] lightmap coords for world rendering, or null for GUI (no lightmap).
   */
  draw(item: string, ctx: DisplayContext, proj: M4, pose: M4, light: [number, number] | null, lightmap: WebGLTexture | null, fog: FogParams | null, lights: [number[], number[]], alpha = 1): void {
    const gl = this.gl; const p = this.prog.use();
    p.m4('ProjMat', proj);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.blockTex.arrays[0]); p.i('Tex16', 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.itemTex); p.i('ItemTex', 1);
    if (lightmap && light) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, lightmap); p.i('Sampler2', 2); p.f('UseLightmap', 1); p.v2('LightUV', light[0], light[1]); }
    else p.f('UseLightmap', 0);
    p.f('UseFog', fog ? 1 : 0); if (fog) setFog(p, fog);
    p.v3('Light0_Direction', lights[0][0], lights[0][1], lights[0][2]); p.v3('Light1_Direction', lights[1][0], lights[1][1], lights[1][2]);
    p.v4('ColorModulator', 1, 1, 1, alpha);
    for (const { m, tints } of this.resolve(item, ctx)) {
      const g = this.gpu(m, tints);
      if (!g) continue;
      const mv = mul(pose, this.transform(g.display, ctx));
      p.m4('ModelViewMat', mv);
      this.gl.uniformMatrix3fv(p.loc('NormalMat'), false, normalMatrix(mv));
      p.f('UseArray', g.useArray ? 1 : 0);
      gl.bindVertexArray(g.vao);
      gl.drawArrays(gl.TRIANGLES, 0, g.count);
    }
    gl.bindVertexArray(null);
  }
}

/** ItemTintSource defaults with no components (constant / grass(t,d) / dye default / potion default...). */
function tintColor(t: any): number {
  const type = String(t.type).replace('minecraft:', '');
  switch (type) {
    case 'constant': return (t.value >>> 0) & 0xffffff;
    case 'grass': return 0x7cbd6b; // GrassColor.get(0.5, 1.0) default for item rendering
    case 'dye': case 'firework': case 'map_color': return ((t.default ?? -1) >>> 0) & 0xffffff;
    case 'potion': return ((t.default ?? -13083194) >>> 0) & 0xffffff;
    default: return 0xffffff;
  }
}

function normalMatrix(m: M4): Float32Array {
  // inverse-transpose of the upper 3x3 (column-major)
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  return new Float32Array([
    A / det, B / det, C / det,
    -(b * i - c * h) / det, (a * i - c * g) / det, -(a * h - b * g) / det,
    (b * f - c * e) / det, -(a * f - c * d) / det, (a * e - b * d) / det,
  ]);
}

/** GUI item rendering (ItemRenderer.renderGuiItem): ortho over GUI pixels, 16px item, Lighting.setupFor3DItems / ForFlatItems. */
export function guiItemPose(x: number, y: number): M4 { return mul(translate(x + 8, y + 8, 150), scale(16, -16, 16)); }
export function orthoGui(w: number, h: number): M4 {
  const m = new Float32Array(16);
  m[0] = 2 / w; m[5] = -2 / h; m[10] = -2 / 2000; m[12] = -1; m[13] = 1; m[14] = 0; m[15] = 1;
  return m;
}
const ryxz = (y: number, x: number) => mul(rotY((y * 180) / Math.PI), rotX((x * 180) / Math.PI));
const apply3 = (m: M4, v: number[]) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];
const M3D = mul(scale(1, -1, 1), mul(ryxz(1.0821041, 3.2375858), ryxz(-0.3926991, 2.3561945)));
const MFLAT = ryxz(-0.3926991, 2.3561945);
export const GUI_LIGHTS_3D: [number[], number[]] = [norm(apply3(M3D, [0.2, 1, -0.7])), norm(apply3(M3D, [-0.2, 1, 0.7]))];
export const GUI_LIGHTS_FLAT: [number[], number[]] = [norm(apply3(MFLAT, [0.2, 1, -0.7])), norm(apply3(MFLAT, [-0.2, 1, 0.7]))];

export const ITEM_LIGHT0 = norm([0.2, 1, -0.7]);
export const ITEM_LIGHT1 = norm([-0.2, 1, 0.7]);
function norm(v: number[]) { const l = Math.hypot(v[0], v[1], v[2]); return v.map((x) => x / l); }
