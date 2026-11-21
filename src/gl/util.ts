// Minimal WebGL2 helpers.
export function compile(gl: WebGL2RenderingContext, vs: string, fs: string, name: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${name} shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name} link: ${gl.getProgramInfoLog(p)}`);
  return p;
}

export class Program {
  readonly p: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();
  constructor(readonly gl: WebGL2RenderingContext, vs: string, fs: string, name: string) { this.p = compile(gl, vs, fs, name); }
  use(): this { this.gl.useProgram(this.p); return this; }
  loc(n: string): WebGLUniformLocation | null {
    if (!this.locs.has(n)) this.locs.set(n, this.gl.getUniformLocation(this.p, n));
    return this.locs.get(n)!;
  }
  m4(n: string, m: Float32Array): void { this.gl.uniformMatrix4fv(this.loc(n), false, m); }
  v4(n: string, a: number, b: number, c: number, d: number): void { this.gl.uniform4f(this.loc(n), a, b, c, d); }
  v3(n: string, a: number, b: number, c: number): void { this.gl.uniform3f(this.loc(n), a, b, c); }
  v2(n: string, a: number, b: number): void { this.gl.uniform2f(this.loc(n), a, b); }
  f(n: string, a: number): void { this.gl.uniform1f(this.loc(n), a); }
  i(n: string, a: number): void { this.gl.uniform1i(this.loc(n), a); }
}

/** Shared quad index buffer: quads -> 6 indices (0,1,2, 2,3,0). */
export function quadIndexBuffer(gl: WebGL2RenderingContext, maxQuads: number): WebGLBuffer {
  const idx = new Uint32Array(maxQuads * 6);
  for (let q = 0; q < maxQuads; q++) {
    const b = q * 4, o = q * 6;
    idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 2; idx[o + 3] = b + 2; idx[o + 4] = b + 3; idx[o + 5] = b;
  }
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  return buf;
}

/** Fog GLSL shared by terrain/sky/clouds — exact port of include/fog.glsl. */
export const FOG_GLSL = `
uniform vec4 FogColor;
uniform float FogEnvironmentalStart, FogEnvironmentalEnd, FogRenderDistanceStart, FogRenderDistanceEnd, FogSkyEnd, FogCloudsEnd;
float linear_fog_value(float d, float s, float e) { if (d <= s) return 0.0; else if (d >= e) return 1.0; return (d - s) / (e - s); }
float total_fog_value(float sd, float cd, float es, float ee, float rs, float re) { return max(linear_fog_value(sd, es, ee), linear_fog_value(cd, rs, re)); }
vec4 apply_fog(vec4 c, float sd, float cd, float es, float ee, float rs, float re, vec4 fc) {
  float v = total_fog_value(sd, cd, es, ee, rs, re);
  return vec4(mix(c.rgb, fc.rgb, v * fc.a), c.a);
}
float fog_spherical_distance(vec3 p) { return length(p); }
float fog_cylindrical_distance(vec3 p) { return max(length(p.xz), abs(p.y)); }
`;
