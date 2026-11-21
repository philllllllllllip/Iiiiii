// CubeMap / PanoramaRenderer (title background: panorama_0..5, 85 deg FOV, pitch 10, spin 0.1 deg per tick)
// and the menu background blur (post_effect "blur": separable Gaussian, radius = menu background
// blurriness, default 5).
import { Program } from '../gl/util';
import { perspective, mul, rotX, rotY } from '../util/mat';
import type { RGBAImage } from '../assets/png';

const CUBE_VS = `#version 300 es
layout(location=0) in vec3 Position; layout(location=1) in vec2 UV0;
uniform mat4 ProjMat; uniform mat4 ModelViewMat; out vec2 uv;
void main() { gl_Position = ProjMat * ModelViewMat * vec4(Position, 1.0); uv = UV0; }`;
const CUBE_FS = `#version 300 es
precision highp float; uniform sampler2D Sampler0; in vec2 uv; out vec4 fragColor;
void main() { fragColor = texture(Sampler0, uv); }`;
const QUAD_VS = `#version 300 es
layout(location=0) in vec2 Position; out vec2 uv;
void main() { uv = Position * 0.5 + 0.5; gl_Position = vec4(Position, 0.0, 1.0); }`;
const BLUR_FS = `#version 300 es
precision highp float; uniform sampler2D Sampler0; uniform vec2 Dir; uniform float Radius; in vec2 uv; out vec4 fragColor;
void main() {
  vec2 px = Dir / vec2(textureSize(Sampler0, 0));
  vec4 acc = vec4(0.0); float tot = 0.0;
  float sigma = max(Radius, 0.001) / 2.0;
  for (float i = -12.0; i <= 12.0; i += 1.0) {
    if (abs(i) > Radius) continue;
    float w = exp(-(i * i) / (2.0 * sigma * sigma));
    acc += texture(Sampler0, uv + px * i) * w; tot += w;
  }
  fragColor = acc / tot;
}`;
const COPY_FS = `#version 300 es
precision highp float; uniform sampler2D Sampler0; in vec2 uv; out vec4 fragColor;
void main() { fragColor = texture(Sampler0, uv); }`;

export class Target {
  fbo: WebGLFramebuffer; tex: WebGLTexture; depth: WebGLRenderbuffer; w = 0; h = 0;
  constructor(readonly gl: WebGL2RenderingContext) {
    this.fbo = gl.createFramebuffer()!; this.tex = gl.createTexture()!; this.depth = gl.createRenderbuffer()!;
  }
  resize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    const gl = this.gl; this.w = w; this.h = h;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  bind(): void { this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo); this.gl.viewport(0, 0, this.w, this.h); }
}

export class Blur {
  private blur: Program; private copy: Program; private vao: WebGLVertexArrayObject;
  readonly a: Target; readonly b: Target;
  constructor(readonly gl: WebGL2RenderingContext) {
    this.blur = new Program(gl, QUAD_VS, BLUR_FS, 'blur'); this.copy = new Program(gl, QUAD_VS, COPY_FS, 'blit');
    this.vao = gl.createVertexArray()!; gl.bindVertexArray(this.vao);
    const b = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, 1, 1, -1, 1, -1, -1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);
    this.a = new Target(gl); this.b = new Target(gl);
  }
  /** Blur `src` into a.tex, then draw it to the default framebuffer. */
  apply(src: Target, radius: number, w: number, h: number): void {
    const gl = this.gl;
    this.a.resize(w, h); this.b.resize(w, h);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.vao);
    const pass = (from: WebGLTexture, to: Target | null, dir: [number, number], prog: Program) => {
      if (to) to.bind(); else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h); }
      const p = prog.use();
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, from); p.i('Sampler0', 0);
      p.v2('Dir', dir[0], dir[1]); p.f('Radius', radius);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    if (radius > 0) { pass(src.tex, this.b, [1, 0], this.blur); pass(this.b.tex, null, [0, 1], this.blur); }
    else pass(src.tex, null, [0, 0], this.copy);
    gl.bindVertexArray(null);
  }
}

export class Panorama {
  private prog: Program; private faces: WebGLTexture[] = []; private vao: WebGLVertexArrayObject;
  spin = 0;
  readonly target: Target;
  constructor(readonly gl: WebGL2RenderingContext, imgs: RGBAImage[]) {
    this.prog = new Program(gl, CUBE_VS, CUBE_FS, 'panorama');
    for (const img of imgs) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.faces.push(t);
    }
    this.vao = gl.createVertexArray()!; gl.bindVertexArray(this.vao);
    const b = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, 0, 1, -1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, -1, 1, 1, 1, -1, -1, 1, 0, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.bindVertexArray(null);
    this.target = new Target(gl);
  }
  /** PanoramaRenderer.render: spin advances 0.1 degrees per tick of elapsed time (panoramaSpeed 1). */
  advance(deltaTicks: number): void { this.spin = (this.spin + deltaTicks * 0.1) % 360; }
  renderTo(w: number, h: number): void {
    const gl = this.gl;
    this.target.resize(w, h); this.target.bind();
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
    const p = this.prog.use();
    p.m4('ProjMat', perspective(85, w / h, 0.05, 10));
    const base = mul(rotX(180), mul(rotX(10), rotY(-this.spin)));
    const faceRot = [rotY(0), rotY(90), rotY(180), rotY(-90), rotX(90), rotX(-90)];
    gl.bindVertexArray(this.vao);
    for (let k = 0; k < 6; k++) {
      p.m4('ModelViewMat', mul(base, faceRot[k]));
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.faces[k]); p.i('Sampler0', 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}
