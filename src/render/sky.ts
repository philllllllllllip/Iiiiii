// SkyRenderer: sky disc, void disc, sunrise/sunset fan, sun, moon, stars.
// Shaders: core/sky.{vsh,fsh}, core/stars.{vsh,fsh}, core/position_tex_color.fsh.
import { Program, FOG_GLSL } from '../gl/util';
import { mul, rotX, rotY, rotZ, translate, type M4 } from '../util/mat';
import { JavaRandom } from '../util/javarandom';
import type { AtlasJson } from '../assets/types';
import type { RGBAImage } from '../assets/png';
import type { FogParams } from './terrain';
import { setFog } from './terrain';

const SKY_VS = `#version 300 es
layout(location=0) in vec3 Position;
uniform mat4 ProjMat; uniform mat4 ModelViewMat;
out float sphericalVertexDistance; out float cylindricalVertexDistance;
${FOG_GLSL}
void main() {
  gl_Position = ProjMat * ModelViewMat * vec4(Position, 1.0);
  sphericalVertexDistance = fog_spherical_distance(Position);
  cylindricalVertexDistance = fog_cylindrical_distance(Position);
}`;
const SKY_FS = `#version 300 es
precision highp float;
uniform vec4 ColorModulator;
in float sphericalVertexDistance; in float cylindricalVertexDistance;
out vec4 fragColor;
${FOG_GLSL}
void main() {
  fragColor = apply_fog(ColorModulator, sphericalVertexDistance, cylindricalVertexDistance, 0.0, FogSkyEnd, FogSkyEnd, FogSkyEnd, FogColor);
}`;
const COLOR_VS = `#version 300 es
layout(location=0) in vec3 Position; layout(location=1) in vec4 Color;
uniform mat4 ProjMat; uniform mat4 ModelViewMat;
out vec4 vertexColor;
void main() { gl_Position = ProjMat * ModelViewMat * vec4(Position, 1.0); vertexColor = Color; }`;
const COLOR_FS = `#version 300 es
precision highp float;
uniform vec4 ColorModulator;
in vec4 vertexColor; out vec4 fragColor;
void main() { vec4 c = vertexColor; if (c.a == 0.0) discard; fragColor = c * ColorModulator; }`;
const TEX_VS = `#version 300 es
layout(location=0) in vec3 Position; layout(location=1) in vec2 UV0;
uniform mat4 ProjMat; uniform mat4 ModelViewMat;
out vec2 texCoord0;
void main() { gl_Position = ProjMat * ModelViewMat * vec4(Position, 1.0); texCoord0 = UV0; }`;
const TEX_FS = `#version 300 es
precision highp float;
uniform sampler2D Sampler0; uniform vec4 ColorModulator;
in vec2 texCoord0; out vec4 fragColor;
void main() { vec4 color = texture(Sampler0, texCoord0); if (color.a == 0.0) discard; fragColor = color * ColorModulator; }`;

export interface SkyState {
  skyColor: number[]; sunriseColor: number[]; sunAngle: number; moonAngle: number; starAngle: number;
  starBrightness: number; moonPhase: string; rain: number; belowHorizon: boolean;
}

export class SkyRenderer {
  private sky: Program; private color: Program; private tex: Program;
  private topDisc: { vao: WebGLVertexArrayObject; n: number };
  private darkDisc: { vao: WebGLVertexArrayObject; n: number };
  private stars: { vao: WebGLVertexArrayObject; n: number };
  private fanVao: WebGLVertexArrayObject; private fanBuf: WebGLBuffer;
  private quadVao: WebGLVertexArrayObject; private quadBuf: WebGLBuffer;
  private celestialTex: WebGLTexture;

  constructor(readonly gl: WebGL2RenderingContext, readonly atlas: AtlasJson, image: RGBAImage) {
    this.sky = new Program(gl, SKY_VS, SKY_FS, 'sky');
    this.color = new Program(gl, COLOR_VS, COLOR_FS, 'position_color');
    this.tex = new Program(gl, TEX_VS, TEX_FS, 'position_tex');
    this.topDisc = this.disc(16); this.darkDisc = this.disc(-16);
    this.stars = this.buildStars();
    this.fanVao = gl.createVertexArray()!; this.fanBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.fanVao); gl.bindBuffer(gl.ARRAY_BUFFER, this.fanBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
    this.quadVao = gl.createVertexArray()!; this.quadBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.quadVao); gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.bindVertexArray(null);
    this.celestialTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.celestialTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, image.width, image.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, image.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  /** SkyRenderer.buildSkyDisc: triangle fan at height y. */
  private disc(y: number) {
    const gl = this.gl;
    const v: number[] = [0, y, 0];
    const g = Math.sign(y) * 512;
    for (let i = -180; i <= 180; i += 45) v.push(g * Math.cos(i * Math.PI / 180), y, 512 * Math.sin(i * Math.PI / 180));
    const vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
    const b = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);
    return { vao, n: v.length / 3 };
  }

  /** SkyRenderer.buildStars: 1500 attempts, RandomSource.create(10842). */
  private buildStars() {
    const gl = this.gl;
    const r = new JavaRandom(10842n);
    const tris: number[] = [];
    for (let i = 0; i < 1500; i++) {
      const f = r.nextFloat() * 2 - 1, g = r.nextFloat() * 2 - 1, h = r.nextFloat() * 2 - 1;
      const j = 0.15 + r.nextFloat() * 0.1;
      const k = f * f + g * g + h * h;
      if (k <= 0.010000001 || k >= 1) continue;
      const len = Math.sqrt(k);
      const v = [(f / len) * 100, (g / len) * 100, (h / len) * 100];
      const l = r.nextDouble() * Math.PI * 2;
      // basis: rotation taking (0,0,-1) to the star direction, then rotated by l about local Z
      const n = [-v[0] / 100, -v[1] / 100, -v[2] / 100]; // local +Z points back to origin
      const up = Math.abs(n[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
      let ax = cross(up, n); ax = norm(ax); const ay = cross(n, ax);
      const c = Math.cos(l), s = Math.sin(l);
      const X = ax.map((a, q) => a * c + ay[q] * s), Y = ay.map((a, q) => a * c - ax[q] * s);
      const corner = (cx: number, cy: number) => [v[0] + X[0] * cx + Y[0] * cy, v[1] + X[1] * cx + Y[1] * cy, v[2] + X[2] * cx + Y[2] * cy];
      const q = [corner(j, -j), corner(j, j), corner(-j, j), corner(-j, -j)];
      tris.push(...q[0], ...q[1], ...q[2], ...q[2], ...q[3], ...q[0]);
    }
    const vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
    const b = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tris), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);
    return { vao, n: tris.length / 3 };
  }

  draw(proj: M4, viewRot: M4, st: SkyState, fog: FogParams): void {
    const gl = this.gl;
    gl.disable(gl.CULL_FACE); gl.depthMask(false); gl.disable(gl.DEPTH_TEST);
    // sky disc
    const sp = this.sky.use();
    sp.m4('ProjMat', proj); sp.m4('ModelViewMat', viewRot); setFog(sp, fog);
    sp.v4('ColorModulator', st.skyColor[0], st.skyColor[1], st.skyColor[2], 1);
    gl.bindVertexArray(this.topDisc.vao); gl.drawArrays(gl.TRIANGLE_FAN, 0, this.topDisc.n);
    gl.enable(gl.BLEND);
    // sunrise / sunset fan
    if (st.sunriseColor[3] > 0) {
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ZERO);
      const sin = Math.sin((st.sunAngle * Math.PI) / 180);
      const m = mul(viewRot, mul(rotX(90), mul(rotZ(sin < 0 ? 180 : 0), rotZ(90))));
      const [r, g, b, a] = st.sunriseColor;
      const v: number[] = [0, 100, 0, r, g, b, a];
      for (let i = 0; i <= 16; i++) {
        const ang = (i * Math.PI * 2) / 16; const s = Math.sin(ang), c = Math.cos(ang);
        v.push(s * 120, c * 120, -c * 40 * a, r, g, b, 0);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fanBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STREAM_DRAW);
      const cp = this.color.use(); cp.m4('ProjMat', proj); cp.m4('ModelViewMat', m); cp.v4('ColorModulator', 1, 1, 1, 1);
      gl.bindVertexArray(this.fanVao); gl.drawArrays(gl.TRIANGLE_FAN, 0, v.length / 7);
    }
    // celestials: additive
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ZERO);
    const alpha = 1 - st.rain;
    const tp = this.tex.use();
    tp.m4('ProjMat', proj); tp.i('Sampler0', 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.celestialTex);
    tp.v4('ColorModulator', 1, 1, 1, alpha);
    this.celestial(tp, mul(viewRot, mul(rotY(-90), rotX(st.sunAngle))), 'sun', 30);
    this.celestial(tp, mul(viewRot, mul(rotY(-90), rotX(st.moonAngle))), 'moon/' + st.moonPhase, 20);
    const sb = st.starBrightness * alpha;
    if (sb > 0) {
      const sp2 = this.sky.use();
      sp2.m4('ProjMat', proj); sp2.m4('ModelViewMat', mul(viewRot, mul(rotY(-90), rotX(st.starAngle))));
      setFog(sp2, { ...fog, skyEnd: 1e9, color: [0, 0, 0, 0] });
      sp2.v4('ColorModulator', sb, sb, sb, sb);
      gl.bindVertexArray(this.stars.vao); gl.drawArrays(gl.TRIANGLES, 0, this.stars.n);
    }
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (st.belowHorizon) {
      const dp = this.sky.use();
      dp.m4('ProjMat', proj); dp.m4('ModelViewMat', mul(viewRot, translate(0, 12, 0)));
      setFog(dp, fog); dp.v4('ColorModulator', 0, 0, 0, 1);
      gl.bindVertexArray(this.darkDisc.vao); gl.drawArrays(gl.TRIANGLE_FAN, 0, this.darkDisc.n);
    }
    gl.disable(gl.BLEND); gl.depthMask(true); gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }

  private endTex: WebGLTexture | null = null;
  /** SkyRenderer.renderEndSky: six faces of a 100-block cube, end_sky.png tiled 16x, colour #282828. */
  drawEnd(proj: M4, viewRot: M4, img: RGBAImage): void {
    const gl = this.gl;
    if (!this.endTex) {
      this.endTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.endTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    }
    gl.disable(gl.CULL_FACE); gl.depthMask(false); gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const tp = this.tex.use();
    tp.m4('ProjMat', proj); tp.i('Sampler0', 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.endTex);
    tp.v4('ColorModulator', 40 / 255, 40 / 255, 40 / 255, 1);
    const faces = [mul(viewRot, rotX(0)), mul(viewRot, rotX(90)), mul(viewRot, rotX(-90)), mul(viewRot, rotX(180)), mul(viewRot, rotZ(90)), mul(viewRot, rotZ(-90))];
    const d = new Float32Array([-100, -100, -100, 0, 0, -100, -100, 100, 0, 16, 100, -100, 100, 16, 16, 100, -100, 100, 16, 16, 100, -100, -100, 16, 0, -100, -100, -100, 0, 0]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf); gl.bufferData(gl.ARRAY_BUFFER, d, gl.STREAM_DRAW);
    gl.bindVertexArray(this.quadVao);
    for (const m of faces) { tp.m4('ModelViewMat', m); gl.drawArrays(gl.TRIANGLES, 0, 6); }
    gl.disable(gl.BLEND); gl.depthMask(true); gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }

  private celestial(p: Program, m: M4, sprite: string, size: number): void {
    const sp = this.atlas.sprites[sprite];
    if (!sp) throw new Error('celestial sprite missing: ' + sprite);
    const gl = this.gl;
    const [x, y] = sp.frames[0];
    const u0 = x / this.atlas.width, v0 = y / this.atlas.height, u1 = (x + sp.w) / this.atlas.width, v1 = (y + sp.h) / this.atlas.height;
    const d = new Float32Array([
      -size, 100, -size, u0, v0, size, 100, -size, u1, v0, size, 100, size, u1, v1,
      size, 100, size, u1, v1, -size, 100, size, u0, v1, -size, 100, -size, u0, v0,
    ]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf); gl.bufferData(gl.ARRAY_BUFFER, d, gl.STREAM_DRAW);
    p.m4('ModelViewMat', m);
    gl.bindVertexArray(this.quadVao); gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]); return a.map((x) => x / l); };
