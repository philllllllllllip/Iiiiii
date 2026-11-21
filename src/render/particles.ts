// ParticleEngine: billboarded particles with vanilla physics (Particle.tick: gravity, friction 0.98,
// lifetime, collision), sprite sets from particles/*.json on the particle atlas, and TerrainParticle
// (block break / crack / sprint dust) sampling a 4x4 texel window of the block's particle sprite.
import { Program, FOG_GLSL } from '../gl/util';
import type { AtlasJson } from '../assets/types';
import type { RGBAImage } from '../assets/png';
import type { FogParams } from './terrain';
import { setFog } from './terrain';
import type { M4 } from '../util/mat';
import type { PhysicsWorld } from '../game/entity';

const VS = `#version 300 es
layout(location=0) in vec3 Position; layout(location=1) in vec2 UV0; layout(location=2) in vec4 Color; layout(location=3) in vec2 Light; layout(location=4) in float Layer;
uniform mat4 ProjMat; uniform mat4 ModelViewMat; uniform sampler2D Sampler2;
out float sphericalVertexDistance; out float cylindricalVertexDistance; out vec2 uv; out vec4 col; flat out float layer;
${FOG_GLSL}
void main() {
  vec4 p = ModelViewMat * vec4(Position, 1.0); gl_Position = ProjMat * p;
  sphericalVertexDistance = fog_spherical_distance(Position); cylindricalVertexDistance = fog_cylindrical_distance(Position);
  col = Color * texture(Sampler2, clamp(Light / 256.0 + 0.5 / 16.0, vec2(0.5 / 16.0), vec2(15.5 / 16.0)));
  uv = UV0; layer = Layer;
}`;
const FS = `#version 300 es
precision highp float; precision highp sampler2DArray;
uniform sampler2D Sampler0; uniform sampler2DArray Tex16; uniform float UseArray;
in float sphericalVertexDistance; in float cylindricalVertexDistance; in vec2 uv; in vec4 col; flat in float layer;
out vec4 fragColor;
${FOG_GLSL}
void main() {
  vec4 c = (UseArray > 0.5 ? texture(Tex16, vec3(uv, layer)) : texture(Sampler0, uv)) * col;
  if (c.a < 0.1) discard;
  fragColor = apply_fog(c, sphericalVertexDistance, cylindricalVertexDistance, FogEnvironmentalStart, FogEnvironmentalEnd, FogRenderDistanceStart, FogRenderDistanceEnd, FogColor);
}`;

export interface Particle {
  x: number; y: number; z: number; xo: number; yo: number; zo: number; vx: number; vy: number; vz: number;
  age: number; lifetime: number; gravity: number; friction: number; size: number; r: number; g: number; b: number; a: number;
  sprites: string[] | null; spriteFromAge: boolean; frame: number;
  terrain?: { layer: number; u0: number; v0: number };
  collide: boolean; onGround: boolean; emissive: boolean; shrink: boolean;
}

const rnd = Math.random;

export class ParticleEngine {
  readonly list: Particle[] = [];
  private prog: Program; private vao: WebGLVertexArrayObject; private buf: WebGLBuffer;
  private tex: WebGLTexture;
  enabled: 'all' | 'decreased' | 'minimal' = 'all';

  constructor(readonly gl: WebGL2RenderingContext, readonly atlas: AtlasJson, img: RGBAImage, readonly defs: Record<string, string[]>, readonly phys: PhysicsWorld | null) {
    this.prog = new Program(gl, VS, FS, 'particle');
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.vao = gl.createVertexArray()!; this.buf = gl.createBuffer()!;
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const S = 12 * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, S, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, S, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, S, 20);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.FLOAT, false, S, 36);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, S, 44);
    gl.bindVertexArray(null);
  }

  private base(x: number, y: number, z: number, vx: number, vy: number, vz: number): Particle {
    // Particle(level, x, y, z, xa, ya, za): random spread then normalise to (rand+rand+1)*0.15 * 0.4
    let dx = vx + (rnd() * 2 - 1) * 0.4, dy = vy + (rnd() * 2 - 1) * 0.4, dz = vz + (rnd() * 2 - 1) * 0.4;
    const d = (rnd() + rnd() + 1) * 0.15, e = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx = (dx / e) * d * 0.4; dy = (dy / e) * d * 0.4 + 0.1; dz = (dz / e) * d * 0.4;
    return { x, y, z, xo: x, yo: y, zo: z, vx: dx, vy: dy, vz: dz, age: 0, lifetime: Math.floor(4 / (rnd() * 0.9 + 0.1)), gravity: 0, friction: 0.98,
      size: 0.1 * (rnd() * 0.5 + 0.5) * 2, r: 1, g: 1, b: 1, a: 1, sprites: null, spriteFromAge: false, frame: 0, collide: true, onGround: false, emissive: false, shrink: false };
  }
  private add(p: Particle): void {
    const cap = this.enabled === 'all' ? 16384 : this.enabled === 'decreased' ? 4096 : 512;
    if (this.list.length >= cap) this.list.shift();
    this.list.push(p);
  }

  /** TerrainParticle from a block's particle sprite. */
  terrain(x: number, y: number, z: number, vx: number, vy: number, vz: number, layer: number, tint: number, raw = false): Particle {
    const p = this.base(x, y, z, vx, vy, vz);
    if (raw) { p.vx = vx; p.vy = vy; p.vz = vz; }
    p.gravity = 1; p.size /= 2;
    p.r = 0.6 * ((tint >> 16) & 255) / 255; p.g = 0.6 * ((tint >> 8) & 255) / 255; p.b = 0.6 * (tint & 255) / 255;
    p.terrain = { layer, u0: rnd() * 3 / 4, v0: rnd() * 3 / 4 };
    this.add(p);
    return p;
  }
  /** ParticleEngine.destroy: 4x4x4 terrain particles across the block. */
  destroy(bx: number, by: number, bz: number, layer: number, tint: number): void {
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) {
      const x = (i + 0.5) / 4, y = (j + 0.5) / 4, z = (k + 0.5) / 4;
      this.terrain(bx + x, by + y, bz + z, x - 0.5, y - 0.5, z - 0.5, layer, tint);
    }
  }
  /** ParticleEngine.crack: one particle on the hit face (setPower 0.2, scale 0.6). */
  crack(bx: number, by: number, bz: number, face: number, layer: number, tint: number): void {
    const e = 0.1;
    let x = bx + rnd() * (1 - e * 2) + e, y = by + rnd() * (1 - e * 2) + e, z = bz + rnd() * (1 - e * 2) + e;
    if (face === 0) y = by - e; if (face === 1) y = by + 1 + e; if (face === 2) z = bz - e; if (face === 3) z = bz + 1 + e; if (face === 4) x = bx - e; if (face === 5) x = bx + 1 + e;
    const p = this.terrain(x, y, z, 0, 0, 0, layer, tint);
    p.vx *= 0.2; p.vy = (p.vy - 0.1) * 0.2 + 0.1; p.vz *= 0.2; p.size *= 0.6;
  }

  /** Sprite particles by type with their provider's physics. */
  spawn(type: string, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): void {
    const sprites = this.defs[type];
    if (!sprites) return;
    const p = this.base(x, y, z, vx, vy, vz);
    p.sprites = sprites;
    switch (type) {
      case 'smoke': case 'large_smoke': case 'poof': // SmokeParticle (BaseAshSmokeParticle): rise, 0.96 friction
        p.vx = vx * 0.1 + (rnd() * 2 - 1) * 0.1 * 0.1; p.vy = vy * 0.1 + (rnd() * 2 - 1) * 0.1 * 0.1; p.vz = vz * 0.1 + (rnd() * 2 - 1) * 0.1 * 0.1;
        { const c = rnd() * 0.3; p.r = p.g = p.b = c; }
        p.size *= type === 'large_smoke' ? 0.75 * 2.5 : 0.75; p.lifetime = Math.floor(8 / (rnd() * 0.8 + 0.2)); p.gravity = -0.1; p.friction = 0.96; p.spriteFromAge = true; p.shrink = true;
        if (type === 'poof') { p.r = p.g = p.b = 1; p.vy = vy + 0.05; }
        break;
      case 'flame': case 'small_flame': case 'soul_fire_flame':
        p.vx = vx * 0.01 + 0; p.vy = vy * 0.01 + 0; p.vz = vz * 0.01; p.x += (rnd() - rnd()) * 0.05; p.z += (rnd() - rnd()) * 0.05;
        p.lifetime = Math.floor(8 / (rnd() * 0.8 + 0.2)) + 4; p.gravity = 0; p.friction = 0.96; p.emissive = true; p.collide = false; p.shrink = true;
        if (type === 'small_flame') p.size *= 0.5;
        break;
      case 'crit': case 'enchanted_hit': case 'damage_indicator':
        p.vx = vx + (rnd() * 2 - 1) * 0.4 * 0.1; p.vy = vy * 0.1 + 0.1 + (rnd() * 2 - 1) * 0.04; p.vz = vz + (rnd() * 2 - 1) * 0.4 * 0.1;
        p.r = p.g = p.b = rnd() * 0.3 + 0.6; p.size *= 0.75; p.lifetime = Math.max(1, Math.floor(6 / (rnd() * 0.8 + 0.6))); p.gravity = 0.5; p.friction = 0.7;
        if (type === 'enchanted_hit') { p.r *= 0.3; p.g *= 0.8; }
        break;
      case 'splash': case 'rain':
        p.vx = vx; p.vy = rnd() * 0.2 + 0.1; p.vz = vz; p.gravity = 0.6; p.size *= 0.5; p.lifetime = Math.floor(8 / (rnd() * 0.8 + 0.2));
        p.frame = Math.floor(rnd() * 4);
        break;
      case 'bubble': case 'bubble_pop': case 'current_down':
        p.vx = vx * 0.2 + (rnd() * 2 - 1) * 0.02; p.vy = vy * 0.2 + (rnd() * 2 - 1) * 0.02; p.vz = vz * 0.2 + (rnd() * 2 - 1) * 0.02;
        p.size *= rnd() * 0.6 + 0.2; p.lifetime = Math.floor(8 / (rnd() * 0.8 + 0.2)); p.gravity = -0.125; p.friction = 0.85;
        break;
      case 'portal': case 'reverse_portal': {
        // PortalParticle moves along a curve back to its origin
        p.vx = vx; p.vy = vy; p.vz = vz; p.collide = false; p.lifetime = Math.floor(rnd() * 10) + 40;
        const f = rnd() * 0.6 + 0.4; p.r = f * 0.9; p.g = f * 0.3; p.b = f; p.size *= rnd() * 0.2 + 0.5; p.gravity = 0; p.friction = 1;
        (p as any).ox = x; (p as any).oy = y; (p as any).oz = z; p.frame = Math.floor(rnd() * 8);
        break;
      }
      case 'explosion':
        p.vx = vx; p.vy = vy; p.vz = vz; p.lifetime = 6 + Math.floor(rnd() * 4); p.size = 2 * (1 - vx * 0.5); { const c = rnd() * 0.6 + 0.4; p.r = p.g = p.b = c; }
        p.spriteFromAge = true; p.collide = false; p.emissive = true; p.gravity = 0; p.friction = 1;
        break;
      case 'heart': case 'angry_villager': case 'happy_villager':
        p.vx *= 0.01; p.vy = vy * 0.01 + 0.1; p.vz *= 0.01; p.size *= 1.5; p.lifetime = 16; p.gravity = 0; p.friction = 0.86; p.collide = false;
        break;
      default:
        p.lifetime = Math.floor(8 / (rnd() * 0.8 + 0.2)); p.spriteFromAge = sprites.length > 1;
    }
    this.add(p);
  }

  /** Explosion emitter: 16 explosion particles spread over 2 ticks worth of positions. */
  explosion(x: number, y: number, z: number, power: number): void {
    for (let i = 0; i < 16; i++) this.spawn('explosion', x + (rnd() - rnd()) * power, y + (rnd() - rnd()) * power, z + (rnd() - rnd()) * power, rnd(), 0, 0);
    for (let i = 0; i < 20; i++) this.spawn('poof', x + (rnd() - rnd()) * power, y + (rnd() - rnd()) * power, z + (rnd() - rnd()) * power, (rnd() - 0.5) * 0.5, rnd() * 0.3, (rnd() - 0.5) * 0.5);
  }

  tick(): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.xo = p.x; p.yo = p.y; p.zo = p.z;
      if (p.age++ >= p.lifetime) { this.list.splice(i, 1); continue; }
      if (p.sprites && p.sprites.length > 1 && (p as any).ox !== undefined) {
        // PortalParticle path
        const f = p.age / p.lifetime, g = -f + f * f * 2, h = 1 - g;
        p.x = (p as any).ox + p.vx * h; p.y = (p as any).oy + p.vy * h + (1 - f); p.z = (p as any).oz + p.vz * h;
        continue;
      }
      p.vy -= 0.04 * p.gravity;
      this.move(p);
      p.vx *= p.friction; p.vy *= p.friction; p.vz *= p.friction;
      if (p.onGround) { p.vx *= 0.7; p.vz *= 0.7; }
    }
  }
  private move(p: Particle): void {
    if (!p.collide || !this.phys) { p.x += p.vx; p.y += p.vy; p.z += p.vz; return; }
    const w = this.phys.world;
    const solidAt = (x: number, y: number, z: number) => {
      const s = w.getState(Math.floor(x), Math.floor(y), Math.floor(z));
      if (s === 0) return false;
      for (const b of this.phys!.props.collision(s)) {
        const fx = x - Math.floor(x), fy = y - Math.floor(y), fz = z - Math.floor(z);
        if (fx >= b[0] && fx <= b[3] && fy >= b[1] && fy <= b[4] && fz >= b[2] && fz <= b[5]) return true;
      }
      return false;
    };
    const ny = p.y + p.vy;
    if (solidAt(p.x, ny, p.z)) { if (p.vy < 0) p.onGround = true; p.vy = 0; } else { p.y = ny; p.onGround = false; }
    const nx = p.x + p.vx; if (solidAt(nx, p.y, p.z)) p.vx = 0; else p.x = nx;
    const nz = p.z + p.vz; if (solidAt(p.x, p.y, nz)) p.vz = 0; else p.z = nz;
  }

  render(proj: M4, view: M4, cam: [number, number, number], yaw: number, pitch: number, partial: number, fog: FogParams | null, lightmap: WebGLTexture, blockArray: WebGLTexture | null, light: (x: number, y: number, z: number) => [number, number]): void {
    if (!this.list.length) return;
    const gl = this.gl;
    // camera-facing basis (Camera rotation)
    const yr = (yaw * Math.PI) / 180, pr = (pitch * Math.PI) / 180;
    const f = [-Math.sin(yr) * Math.cos(pr), -Math.sin(pr), Math.cos(yr) * Math.cos(pr)];
    const right = [Math.cos(yr), 0, Math.sin(yr)];
    const up = [f[1] * right[2] - f[2] * right[1], f[2] * right[0] - f[0] * right[2], f[0] * right[1] - f[1] * right[0]];
    const batches: [boolean, number[]][] = [[false, []], [true, []]];
    for (const p of this.list) {
      const x = p.xo + (p.x - p.xo) * partial - cam[0], y = p.yo + (p.y - p.yo) * partial - cam[1], z = p.zo + (p.z - p.zo) * partial - cam[2];
      let s = p.size;
      if (p.shrink) { const f = (p.age + partial) / p.lifetime; s *= 1 - f * f * 0.5; }
      const L: [number, number] = p.emissive ? [240, 240] : light(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      let u0: number, v0: number, u1: number, v1: number, layer = 0;
      if (p.terrain) { layer = p.terrain.layer; u0 = p.terrain.u0; v0 = p.terrain.v0; u1 = u0 + 0.25; v1 = v0 + 0.25; }
      else {
        const sprites = p.sprites!;
        const idx = p.spriteFromAge ? Math.min(sprites.length - 1, Math.floor((p.age * sprites.length) / p.lifetime)) : p.frame % sprites.length;
        const sp = this.atlas.sprites[sprites[idx]];
        if (!sp) continue;
        const [ax, ay] = sp.frames[0];
        u0 = ax / this.atlas.width; v0 = ay / this.atlas.height; u1 = (ax + sp.w) / this.atlas.width; v1 = (ay + sp.h) / this.atlas.height;
      }
      const out = batches[p.terrain ? 1 : 0][1];
      const corner = (cx: number, cy: number, u: number, v: number) => out.push(x + (right[0] * cx + up[0] * cy) * s, y + (right[1] * cx + up[1] * cy) * s, z + (right[2] * cx + up[2] * cy) * s, u, v, p.r, p.g, p.b, p.a, L[0], L[1], layer);
      corner(-1, -1, u1, v1); corner(-1, 1, u1, v0); corner(1, 1, u0, v0); corner(1, 1, u0, v0); corner(1, -1, u0, v1); corner(-1, -1, u1, v1);
    }
    const pr2 = this.prog.use();
    pr2.m4('ProjMat', proj); pr2.m4('ModelViewMat', view);
    if (fog) setFog(pr2, fog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex); pr2.i('Sampler0', 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D_ARRAY, blockArray); pr2.i('Tex16', 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, lightmap); pr2.i('Sampler2', 2);
    gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    for (const [arr, data] of batches) {
      if (!data.length) continue;
      pr2.f('UseArray', arr ? 1 : 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STREAM_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, data.length / 12);
    }
    gl.bindVertexArray(null); gl.disable(gl.BLEND); gl.enable(gl.CULL_FACE);
  }
}
