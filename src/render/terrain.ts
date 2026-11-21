// Chunk section rendering. Shader is a port of 26.3 core/terrain.vsh/.fsh + include/texture_sampling.glsl
// (sampleNearest), include/sample_lightmap.glsl and include/fog.glsl to GLSL ES 3.00, with the block
// atlas replaced by three sampler2DArrays (16/32/64 px layers).
import { Program, FOG_GLSL } from '../gl/util';
import type { SectionMesh } from '../mesh/mesher';
import type { M4 } from '../util/mat';

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
out float sphericalVertexDistance; out float cylindricalVertexDistance;
out vec4 vertexColor; out vec2 texCoord0; flat out uvec2 slot;
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
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray Tex16; uniform sampler2DArray Tex32; uniform sampler2DArray Tex64;
uniform float AlphaCutout;
in float sphericalVertexDistance; in float cylindricalVertexDistance;
in vec4 vertexColor; in vec2 texCoord0; flat in uvec2 slot;
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
  fragColor = apply_fog(color, sphericalVertexDistance, cylindricalVertexDistance,
    FogEnvironmentalStart, FogEnvironmentalEnd, FogRenderDistanceStart, FogRenderDistanceEnd, FogColor);
}`;

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
export interface GpuSection { x: number; y: number; z: number; layers: (GpuLayer | null)[] }

export class TerrainRenderer {
  readonly prog: Program;
  readonly sections = new Map<number, GpuSection>();

  constructor(readonly gl: WebGL2RenderingContext, readonly sharedIndex: WebGLBuffer) {
    this.prog = new Program(gl, VS, FS, 'terrain');
  }

  upload(key: number, sx: number, sy: number, sz: number, mesh: SectionMesh): void {
    this.remove(key);
    const gl = this.gl;
    const sec: GpuSection = { x: sx * 16, y: sy * 16, z: sz * 16, layers: [null, null, null] };
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

  draw(proj: M4, view: M4, cam: [number, number, number], fog: FogParams, arrays: (WebGLTexture | null)[], lightmap: WebGLTexture,
    visible: (s: GpuSection) => boolean): number {
    const gl = this.gl; const p = this.prog.use();
    p.m4('ProjMat', proj); p.m4('ModelViewMat', view);
    setFog(p, fog);
    for (let a = 0; a < 3; a++) { gl.activeTexture(gl.TEXTURE0 + a); gl.bindTexture(gl.TEXTURE_2D_ARRAY, arrays[a]); }
    p.i('Tex16', 0); p.i('Tex32', 1); p.i('Tex64', 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, lightmap); p.i('Sampler2', 3);
    const vis: GpuSection[] = [];
    for (const s of this.sections.values()) if (visible(s)) vis.push(s);
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
