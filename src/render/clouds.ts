// CloudRenderer (fancy clouds): textures/environment/clouds.png, one 12x4x12 cell per opaque texel,
// faces only towards empty neighbours, per-face shading from core/clouds.vsh, alpha faded by
// FogCloudsEnd (core/clouds.fsh). Drift: 0.03 blocks/tick towards -X.
import { Program, FOG_GLSL } from '../gl/util';
import type { RGBAImage } from '../assets/png';
import type { M4 } from '../util/mat';
import type { FogParams } from './terrain';
import { setFog } from './terrain';

const VS = `#version 300 es
layout(location=0) in vec3 Position; layout(location=1) in float Shade;
uniform mat4 ProjMat; uniform mat4 ModelViewMat; uniform vec3 CloudOffset; uniform vec4 CloudColor;
out float vertexDistance; out vec4 vertexColor;
${FOG_GLSL}
void main() {
  vec3 pos = Position + CloudOffset;
  gl_Position = ProjMat * ModelViewMat * vec4(pos, 1.0);
  vertexDistance = fog_spherical_distance(pos);
  vertexColor = vec4(vec3(Shade), 1.0) * CloudColor;
}`;
const FS = `#version 300 es
precision highp float;
in float vertexDistance; in vec4 vertexColor; out vec4 fragColor;
${FOG_GLSL}
void main() {
  vec4 color = vertexColor;
  color.a *= 1.0 - linear_fog_value(vertexDistance, 0.0, FogCloudsEnd);
  fragColor = color;
}`;

const CELL = 12, HEIGHT = 4;
// face shade per direction: bottom, top, north, south, west, east (clouds.vsh faceColors)
const SHADES = [0.7, 1.0, 0.8, 0.8, 0.9, 0.9];

export class CloudRenderer {
  private prog: Program;
  private vao: WebGLVertexArrayObject; private buf: WebGLBuffer; private count = 0;
  private builtFor = '';
  private opaque: Uint8Array; private w: number; private h: number;

  constructor(readonly gl: WebGL2RenderingContext, tex: RGBAImage, readonly radiusCells = 32) {
    this.prog = new Program(gl, VS, FS, 'clouds');
    this.w = tex.width; this.h = tex.height;
    this.opaque = new Uint8Array(tex.width * tex.height);
    for (let i = 0; i < this.opaque.length; i++) this.opaque[i] = tex.data[i * 4 + 3] >= 10 ? 1 : 0;
    this.vao = gl.createVertexArray()!; this.buf = gl.createBuffer()!;
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
    gl.bindVertexArray(null);
  }

  private cell(x: number, z: number): number {
    return this.opaque[(((z % this.h) + this.h) % this.h) * this.w + (((x % this.w) + this.w) % this.w)];
  }

  /** Rebuild cell geometry around cell (cx, cz), relative to that cell's origin. */
  private build(cx: number, cz: number, relY: number): void {
    const v: number[] = [];
    const R = this.radiusCells;
    const quad = (p: number[][], shade: number) => {
      for (const i of [0, 1, 2, 2, 3, 0]) v.push(p[i][0], p[i][1], p[i][2], shade);
    };
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      if (!this.cell(cx + dx, cz + dz)) continue;
      const x0 = dx * CELL, z0 = dz * CELL, x1 = x0 + CELL, z1 = z0 + CELL, y0 = 0, y1 = HEIGHT;
      // camera above the layer sees tops, below sees bottoms; inside sees both
      if (relY > -HEIGHT) quad([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], SHADES[1]);
      if (relY < HEIGHT * 2) quad([[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], SHADES[0]);
      if (!this.cell(cx + dx, cz + dz - 1)) quad([[x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [x0, y1, z0]], SHADES[2]);
      if (!this.cell(cx + dx, cz + dz + 1)) quad([[x0, y1, z1], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1]], SHADES[3]);
      if (!this.cell(cx + dx - 1, cz + dz)) quad([[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]], SHADES[4]);
      if (!this.cell(cx + dx + 1, cz + dz)) quad([[x1, y1, z1], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0]], SHADES[5]);
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    this.count = v.length / 4;
  }

  draw(proj: M4, view: M4, cam: [number, number, number], gameTime: number, partial: number, height: number, color: number[], fog: FogParams): void {
    if (color[3] <= 0) return;
    const drift = (gameTime + partial) * 0.03;
    const wx = cam[0] + drift, wz = cam[2] + 0.33 * CELL;
    const cx = Math.floor(wx / CELL), cz = Math.floor(wz / CELL);
    const relY = cam[1] - height;
    const band = relY > HEIGHT ? 'above' : relY < 0 ? 'below' : 'inside';
    const key = `${cx},${cz},${band}`;
    if (key !== this.builtFor) { this.build(cx, cz, relY); this.builtFor = key; }
    const gl = this.gl; const p = this.prog.use();
    p.m4('ProjMat', proj); p.m4('ModelViewMat', view); setFog(p, fog);
    p.v3('CloudOffset', cx * CELL - wx, height - cam[1], cz * CELL - wz);
    p.v4('CloudColor', color[0], color[1], color[2], color[3]);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
    if (band === 'inside') gl.disable(gl.CULL_FACE);
    // depth pre-pass so overlapping translucent faces don't double-blend (vanilla renders clouds this way)
    gl.colorMask(false, false, false, false); gl.depthMask(true);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    gl.colorMask(true, true, true, true); gl.depthMask(false); gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    gl.disable(gl.BLEND); gl.depthMask(true); gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);
  }
}
