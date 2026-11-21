// Block outline (rendertype_lines: black, alpha 0.4) and break progress (rendertype_crumbling:
// destroy_stage_N sprites, blend DST_COLOR/SRC_COLOR over the block's faces).
import { Program } from '../gl/util';
import type { M4 } from '../util/mat';
import type { AABB } from '../game/blockprops';

const LINE_VS = `#version 300 es
layout(location=0) in vec3 Position; layout(location=1) in vec3 Other; layout(location=2) in float Side;
uniform mat4 ProjMat; uniform mat4 ModelViewMat; uniform vec2 ScreenSize; uniform float LineWidth;
void main() {
  vec4 a = ProjMat * ModelViewMat * vec4(Position, 1.0);
  vec4 b = ProjMat * ModelViewMat * vec4(Other, 1.0);
  vec2 sa = a.xy / a.w * ScreenSize, sb = b.xy / b.w * ScreenSize;
  vec2 dir = normalize(sb - sa);
  vec2 n = vec2(-dir.y, dir.x) * LineWidth / ScreenSize;
  gl_Position = a + vec4(n * Side * a.w, 0.0, 0.0);
}`;
const LINE_FS = `#version 300 es
precision highp float; uniform vec4 ColorModulator; out vec4 fragColor;
void main() { fragColor = ColorModulator; }`;

const CRUMB_VS = `#version 300 es
layout(location=0) in vec3 Position; layout(location=1) in vec2 UV0;
uniform mat4 ProjMat; uniform mat4 ModelViewMat; out vec2 texCoord0;
void main() { gl_Position = ProjMat * ModelViewMat * vec4(Position, 1.0); texCoord0 = UV0; }`;
const CRUMB_FS = `#version 300 es
precision highp float; precision highp sampler2DArray;
uniform sampler2DArray Tex16; uniform float Layer; in vec2 texCoord0; out vec4 fragColor;
void main() { vec4 c = texture(Tex16, vec3(texCoord0, Layer)); if (c.a < 0.1) discard; fragColor = c; }`;

export class Overlays {
  private line: Program; private crumb: Program;
  private vao: WebGLVertexArrayObject; private buf: WebGLBuffer;
  private cvao: WebGLVertexArrayObject; private cbuf: WebGLBuffer;
  constructor(readonly gl: WebGL2RenderingContext) {
    this.line = new Program(gl, LINE_VS, LINE_FS, 'lines');
    this.crumb = new Program(gl, CRUMB_VS, CRUMB_FS, 'crumbling');
    this.vao = gl.createVertexArray()!; this.buf = gl.createBuffer()!;
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 24);
    this.cvao = gl.createVertexArray()!; this.cbuf = gl.createBuffer()!;
    gl.bindVertexArray(this.cvao); gl.bindBuffer(gl.ARRAY_BUFFER, this.cbuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.bindVertexArray(null);
  }

  /** Selection outline for boxes in camera-relative space (grown by 0.002 like vanilla). */
  outline(proj: M4, view: M4, boxes: AABB[], ox: number, oy: number, oz: number, w: number, h: number): void {
    const gl = this.gl;
    const v: number[] = [];
    const e = 0.002;
    const seg = (a: number[], b: number[]) => {
      for (const [p, q, s] of [[a, b, -1], [a, b, 1], [b, a, 1], [b, a, 1], [b, a, -1], [a, b, -1]] as [number[], number[], number][]) v.push(p[0], p[1], p[2], q[0], q[1], q[2], s);
    };
    for (const bx of boxes) {
      const x0 = bx[0] + ox - e, y0 = bx[1] + oy - e, z0 = bx[2] + oz - e, x1 = bx[3] + ox + e, y1 = bx[4] + oy + e, z1 = bx[5] + oz + e;
      const c = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
      for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) seg(c[i], c[j]);
    }
    const p = this.line.use();
    p.m4('ProjMat', proj); p.m4('ModelViewMat', view); p.v2('ScreenSize', w, h);
    p.f('LineWidth', Math.max(2.5, (Math.max(w, h) / 1920) * 2.5) / 1);
    p.v4('ColorModulator', 0, 0, 0, 0.4);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STREAM_DRAW);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLES, 0, v.length / 7);
    gl.depthMask(true); gl.disable(gl.BLEND); gl.enable(gl.CULL_FACE); gl.bindVertexArray(null);
  }

  /** Crumbling overlay: faces of the block's boxes with world-projected UVs (SheetedDecalTextureGenerator). */
  crumbling(proj: M4, view: M4, boxes: AABB[], bx: number, by: number, bz: number, ox: number, oy: number, oz: number, tex: WebGLTexture, layer: number): void {
    const gl = this.gl; const v: number[] = [];
    const e = 0.001;
    for (const b of boxes) {
      const x0 = b[0] - e, y0 = b[1] - e, z0 = b[2] - e, x1 = b[3] + e, y1 = b[4] + e, z1 = b[5] + e;
      const q = (pts: number[][], uv: (p: number[]) => number[]) => { for (const i of [0, 1, 2, 2, 3, 0]) { const p = pts[i]; const t = uv(p); v.push(p[0] + ox, p[1] + oy, p[2] + oz, t[0], t[1]); } };
      q([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], (p) => [p[0], p[2]]);
      q([[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], (p) => [p[0], 1 - p[2]]);
      q([[x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [x0, y1, z0]], (p) => [1 - p[0], 1 - p[1]]);
      q([[x0, y1, z1], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1]], (p) => [p[0], 1 - p[1]]);
      q([[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]], (p) => [p[2], 1 - p[1]]);
      q([[x1, y1, z1], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0]], (p) => [1 - p[2], 1 - p[1]]);
    }
    void bx; void by; void bz;
    const p = this.crumb.use();
    p.m4('ProjMat', proj); p.m4('ModelViewMat', view); p.f('Layer', layer);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex); p.i('Tex16', 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cbuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STREAM_DRAW);
    gl.enable(gl.BLEND); gl.blendFunc(gl.DST_COLOR, gl.SRC_COLOR);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-3, -3);
    gl.depthMask(false); gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(this.cvao); gl.drawArrays(gl.TRIANGLES, 0, v.length / 5);
    gl.disable(gl.POLYGON_OFFSET_FILL); gl.depthMask(true); gl.disable(gl.BLEND); gl.bindVertexArray(null);
  }
}
