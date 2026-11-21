// Chunk section rendering. Shader is a port of 26.3 core/terrain.vsh/.fsh + include/texture_sampling.glsl
// (sampleNearest), include/sample_lightmap.glsl and include/fog.glsl to GLSL ES 3.00, with the block
// atlas replaced by three sampler2DArrays (16/32/64 px layers).
import { Program, FOG_GLSL } from '../gl/util';
import type { SectionMesh } from '../mesh/mesher';
import type { M4 } from '../util/mat';
import { connected as connectedFaces } from '../mesh/mesher';

const VS = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec3 Position;
layout(location=1) in vec2 UV0;
layout(location=2) in uvec2 Slot;
layout(location=3) in vec4 Color;
layout(location=4) in uvec2 UV2;
uniform mat4 ProjMat; uniform mat4 ModelViewMat;
uniform vec3 ChunkOffset;
uniform sampler2D Sampler2;
uniform mat4 ShadowMat; uniform float ShadowsOn;
out float sphericalVertexDistance; out float cylindricalVertexDistance;
out vec4 vertexColor; out vec2 texCoord0; flat out uvec2 slot; out vec4 shadowCoord; out float skyAmount;
${FOG_GLSL}
vec4 sample_lightmap(sampler2D lightMap, ivec2 uv) {
  return texture(lightMap, clamp((vec2(uv) / 256.0) + 0.5 / 16.0, vec2(0.5 / 16.0), vec2(15.5 / 16.0)));
}
void main() {
  vec3 pos = Position + ChunkOffset;
  gl_Position = ProjMat * ModelViewMat * vec4(pos, 1.0);
  sphericalVertexDistance = fog_spherical_distance(pos);
  cylindricalVertexDistance = fog_cylindrical_distance(pos);
  vertexColor = Color * sample_lightmap(Sampler2, ivec2(UV2));
  texCoord0 = UV0;
  slot = Slot;
  shadowCoord = ShadowsOn > 0.5 ? ShadowMat * vec4(pos, 1.0) : vec4(0.0);
  skyAmount = float(UV2.y) / 240.0;
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray Tex16; uniform sampler2DArray Tex32; uniform sampler2DArray Tex64;
uniform float AlphaCutout;
uniform highp sampler2DShadow ShadowMap; uniform float ShadowsOn; uniform float ShadowStrength;
in float sphericalVertexDistance; in float cylindricalVertexDistance;
in vec4 vertexColor; in vec2 texCoord0; flat in uvec2 slot; in vec4 shadowCoord; in float skyAmount;
out vec4 fragColor;
${FOG_GLSL}
vec4 sampleNearestArr(sampler2DArray source, vec2 uv, float layer, vec2 pixelSize) {
  vec2 du = dFdx(uv); vec2 dv = dFdy(uv);
  vec2 texelScreenSize = sqrt(du * du + dv * dv);
  vec2 uvTexelCoords = uv / pixelSize;
  vec2 texelCenter = round(uvTexelCoords) - 0.5;
  vec2 texelOffset = uvTexelCoords - texelCenter;
  texelOffset = (texelOffset - 0.5) * pixelSize / texelScreenSize + 0.5;
  texelOffset = clamp(texelOffset, 0.0, 1.0);
  uv = (texelCenter + texelOffset) * pixelSize;
  return textureGrad(source, vec3(uv, layer), du, dv);
}
void main() {
  float layer = float(slot.x);
  vec4 tex;
  if (slot.y == 0u) tex = sampleNearestArr(Tex16, texCoord0, layer, vec2(1.0 / 16.0));
  else if (slot.y == 1u) tex = sampleNearestArr(Tex32, texCoord0, layer, vec2(1.0 / 32.0));
  else tex = sampleNearestArr(Tex64, texCoord0, layer, vec2(1.0 / 64.0));
  vec4 color = tex * vertexColor;
  if (color.a < AlphaCutout) discard;
  if (ShadowsOn > 0.5) {
    // 3x3 PCF; fades out at the cascade edge; only darkens sky-lit surfaces
    vec3 sc = shadowCoord.xyz / shadowCoord.w * 0.5 + 0.5;
    if (sc.x > 0.0 && sc.x < 1.0 && sc.y > 0.0 && sc.y < 1.0 && sc.z < 1.0) {
      float lit = 0.0; vec2 ts = 1.0 / vec2(textureSize(ShadowMap, 0));
      for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) lit += texture(ShadowMap, vec3(sc.xy + vec2(i, j) * ts, sc.z));
      lit /= 9.0;
      vec2 e = abs(sc.xy - 0.5) * 2.0; float fade = clamp((1.0 - max(e.x, e.y)) * 8.0, 0.0, 1.0);
      color.rgb *= mix(1.0, 1.0 - ShadowStrength * skyAmount, (1.0 - lit) * fade);
    }
  }
  fragColor = apply_fog(color, sphericalVertexDistance, cylindricalVertexDistance,
    FogEnvironmentalStart, FogEnvironmentalEnd, FogRenderDistanceStart, FogRenderDistanceEnd, FogColor);
}`;

const DEPTH_VS = `#version 300 es
layout(location=0) in vec3 Position; layout(location=1) in vec2 UV0; layout(location=2) in uvec2 Slot;
uniform mat4 ShadowMat; uniform vec3 ChunkOffset; out vec2 uv; flat out uvec2 slot;
void main() { gl_Position = ShadowMat * vec4(Position + ChunkOffset, 1.0); uv = UV0; slot = Slot; }`;
const DEPTH_FS = `#version 300 es
precision highp float; precision highp sampler2DArray; uniform sampler2DArray Tex16; uniform float AlphaCutout;
in vec2 uv; flat in uvec2 slot; out vec4 o;
void main() { if (AlphaCutout > 0.0 && slot.y == 0u && texture(Tex16, vec3(uv, float(slot.x))).a < AlphaCutout) discard; o = vec4(1.0); }`;

export interface FogParams {
  color: [number, number, number, number];
  envStart: number; envEnd: number; rdStart: number; rdEnd: number; skyEnd: number; cloudsEnd: number;
}

export function setFog(p: Program, f: FogParams): void {
  p.v4('FogColor', f.color[0], f.color[1], f.color[2], f.color[3]);
  p.f('FogEnvironmentalStart', f.envStart); p.f('FogEnvironmentalEnd', f.envEnd);
  p.f('FogRenderDistanceStart', f.rdStart); p.f('FogRenderDistanceEnd', f.rdEnd);
  p.f('FogSkyEnd', f.skyEnd); p.f('FogCloudsEnd', f.cloudsEnd);
}

interface GpuLayer { vao: WebGLVertexArrayObject; vbo: WebGLBuffer; quads: number; ibo?: WebGLBuffer; centers?: Float32Array; sortedAt?: [number, number, number] }
export interface GpuSection { x: number; y: number; z: number; layers: (GpuLayer | null)[]; vis: number }

export class TerrainRenderer {
  readonly prog: Program;
  readonly sections = new Map<number, GpuSection>();

  private depthProg: Program;
  shadow: { tex: WebGLTexture; fbo: WebGLFramebuffer; size: number; mat: Float32Array; strength: number } | null = null;
  constructor(readonly gl: WebGL2RenderingContext, readonly sharedIndex: WebGLBuffer) {
    this.prog = new Program(gl, VS, FS, 'terrain');
    this.depthProg = new Program(gl, DEPTH_VS, DEPTH_FS, 'terrain_shadow');
  }

  /** Render solid+cutout sections into the sun shadow map (front faces culled + slope-scaled bias). */
  renderShadow(mat: Float32Array, cam: [number, number, number], arrays: (WebGLTexture | null)[], within: (s: GpuSection) => boolean, size = 2048): void {
    const gl = this.gl;
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    if (!this.shadow || this.shadow.size !== size) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, size, size);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
      this.shadow = { tex, fbo, size, mat, strength: 0.4 };
    }
    this.shadow.mat = mat;
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadow.fbo);
    gl.viewport(0, 0, size, size);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.BLEND);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2.0, 4.0);
    gl.disable(gl.CULL_FACE);
    const p = this.depthProg.use();
    p.m4('ShadowMat', mat);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, arrays[0]); p.i('Tex16', 0);
    for (const s of this.sections.values()) {
      if (!within(s)) continue;
      for (let l = 0; l < 2; l++) {
        const L = s.layers[l]; if (!L) continue;
        p.f('AlphaCutout', l === 0 ? 0 : 0.5);
        p.v3('ChunkOffset', s.x - cam[0], s.y - cam[1], s.z - cam[2]);
        gl.bindVertexArray(L.vao);
        gl.drawElements(gl.TRIANGLES, L.quads * 6, gl.UNSIGNED_INT, 0);
      }
    }
    gl.disable(gl.POLYGON_OFFSET_FILL); gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
  }

  upload(key: number, sx: number, sy: number, sz: number, mesh: SectionMesh): void {
    this.remove(key);
    const gl = this.gl;
    const sec: GpuSection = { x: sx * 16, y: sy * 16, z: sz * 16, layers: [null, null, null], vis: mesh.vis ?? 0x7fff };
    for (let l = 0; l < 3; l++) {
      if (!mesh.quads[l]) continue;
      const vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
      const vbo = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.layers[l], gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 12);
      gl.enableVertexAttribArray(2); gl.vertexAttribIPointer(2, 2, gl.UNSIGNED_SHORT, 32, 20);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 32, 24);
      gl.enableVertexAttribArray(4); gl.vertexAttribIPointer(4, 2, gl.UNSIGNED_BYTE, 32, 28);
      const layer: GpuLayer = { vao, vbo, quads: mesh.quads[l] };
      if (l === 2) { layer.ibo = gl.createBuffer()!; layer.centers = mesh.centers; gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, layer.ibo); }
      else gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.sharedIndex);
      gl.bindVertexArray(null);
      sec.layers[l] = layer;
    }
    this.sections.set(key, sec);
  }

  shadowsOn = false;
  private dummy: WebGLTexture | null = null;
  private dummyShadow(): WebGLTexture {
    if (this.dummy) return this.dummy;
    const gl = this.gl; const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, 1, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return (this.dummy = t);
  }

  remove(key: number): void {
    const s = this.sections.get(key);
    if (!s) return;
    for (const l of s.layers) if (l) { this.gl.deleteBuffer(l.vbo); if (l.ibo) this.gl.deleteBuffer(l.ibo); this.gl.deleteVertexArray(l.vao); }
    this.sections.delete(key);
  }

  /** Re-sort a translucent layer back to front for the camera (vanilla resorts translucent sections). */
  private sortTranslucent(s: GpuSection, l: GpuLayer, cx: number, cy: number, cz: number): void {
    const lx = cx - s.x, ly = cy - s.y, lz = cz - s.z;
    if (l.sortedAt && Math.abs(l.sortedAt[0] - lx) + Math.abs(l.sortedAt[1] - ly) + Math.abs(l.sortedAt[2] - lz) < 1) return;
    l.sortedAt = [lx, ly, lz];
    const c = l.centers!; const n = l.quads;
    const order = new Uint32Array(n); const dist = new Float32Array(n);
    for (let i = 0; i < n; i++) { order[i] = i; const dx = c[i * 3] - lx, dy = c[i * 3 + 1] - ly, dz = c[i * 3 + 2] - lz; dist[i] = dx * dx + dy * dy + dz * dz; }
    order.sort((a, b) => dist[b] - dist[a]);
    const idx = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) { const b = order[i] * 4, o = i * 6; idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 2; idx[o + 3] = b + 2; idx[o + 4] = b + 3; idx[o + 5] = b; }
    const gl = this.gl;
    gl.bindVertexArray(l.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, l.ibo!);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
  }

  /**
   * SectionOcclusionGraph: breadth-first walk from the camera section; a neighbour is entered through
   * face f only if the current section connects its entry face to f (VisibilitySet) and it is in the
   * frustum. Sections that never received a mesh (all air) are treated as fully open.
   */
  occlusionCull(cam: [number, number, number], visible: (s: GpuSection) => boolean): GpuSection[] {
    const key = (x: number, y: number, z: number) => ((x + 32768) * 65536 + (z + 32768)) * 32 + (y + 4);
    const cx = Math.floor(cam[0] / 16), cy = Math.floor(cam[1] / 16), cz = Math.floor(cam[2] / 16);
    const out: GpuSection[] = [];
    const seen = new Set<number>();
    const D = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
    const q: [number, number, number, number][] = [[cx, Math.max(-4, Math.min(19, cy)), cz, -1]];
    seen.add(key(q[0][0], q[0][1], q[0][2]));
    let head = 0;
    while (head < q.length && head < 40000) {
      const [x, y, z, from] = q[head++];
      const s = this.sections.get(key(x, y, z));
      if (s && visible(s)) out.push(s);
      const vis = s ? s.vis : 0x7fff;
      for (let d = 0; d < 6; d++) {
        if (from >= 0 && d === (from ^ 1)) continue;
        if (from >= 0 && !connectedFaces(vis, from, d)) continue;
        const nx = x + D[d][0], ny = y + D[d][1], nz = z + D[d][2];
        if (ny < -4 || ny > 19) continue;
        if (Math.abs(nx - cx) > 40 || Math.abs(nz - cz) > 40) continue;
        const k = key(nx, ny, nz);
        if (seen.has(k)) continue;
        seen.add(k);
        const ns = this.sections.get(k);
        const bx = nx * 16 - cam[0], by = ny * 16 - cam[1], bz = nz * 16 - cam[2];
        if (ns && !visible(ns)) continue;
        if (!ns && !this.frustumBox(bx, by, bz)) continue;
        // entering the neighbour through its face opposite to d
        q.push([nx, ny, nz, d ^ 1]);
      }
    }
    return out;
  }
  frustumBox: (x: number, y: number, z: number) => boolean = () => true;

  draw(proj: M4, view: M4, cam: [number, number, number], fog: FogParams, arrays: (WebGLTexture | null)[], lightmap: WebGLTexture,
    visible: (s: GpuSection) => boolean): number {
    const gl = this.gl; const p = this.prog.use();
    p.m4('ProjMat', proj); p.m4('ModelViewMat', view);
    setFog(p, fog);
    for (let a = 0; a < 3; a++) { gl.activeTexture(gl.TEXTURE0 + a); gl.bindTexture(gl.TEXTURE_2D_ARRAY, arrays[a]); }
    p.i('Tex16', 0); p.i('Tex32', 1); p.i('Tex64', 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, lightmap); p.i('Sampler2', 3);
    if (this.shadowsOn && this.shadow) {
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.shadow.tex); p.i('ShadowMap', 4);
      p.f('ShadowsOn', 1); p.m4('ShadowMat', this.shadow.mat); p.f('ShadowStrength', this.shadow.strength);
    } else { p.f('ShadowsOn', 0); gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.dummyShadow()); p.i('ShadowMap', 4); }
    const vis = this.occlusionCull(cam, visible);
    let drawn = 0;
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.enable(gl.CULL_FACE); gl.depthMask(true); gl.disable(gl.BLEND);
    for (let l = 0; l < 2; l++) {
      p.f('AlphaCutout', l === 0 ? -1 : 0.5);
      for (const s of vis) {
        const L = s.layers[l]; if (!L) continue;
        p.v3('ChunkOffset', s.x - cam[0], s.y - cam[1], s.z - cam[2]);
        gl.bindVertexArray(L.vao);
        gl.drawElements(gl.TRIANGLES, L.quads * 6, gl.UNSIGNED_INT, 0);
        drawn++;
      }
    }
    // translucent: far to near, blended, no depth write
    vis.sort((a, b) => dist2(b, cam) - dist2(a, cam));
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    p.f('AlphaCutout', 0.01);
    for (const s of vis) {
      const L = s.layers[2]; if (!L) continue;
      this.sortTranslucent(s, L, cam[0], cam[1], cam[2]);
      p.v3('ChunkOffset', s.x - cam[0], s.y - cam[1], s.z - cam[2]);
      gl.bindVertexArray(L.vao);
      gl.drawElements(gl.TRIANGLES, L.quads * 6, gl.UNSIGNED_INT, 0);
      drawn++;
    }
    gl.depthMask(true); gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    return drawn;
  }
}

const dist2 = (s: GpuSection, c: number[]) => { const dx = s.x + 8 - c[0], dy = s.y + 8 - c[1], dz = s.z + 8 - c[2]; return dx * dx + dy * dy + dz * dz; };
