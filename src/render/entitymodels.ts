// Entity models: ModelPart/CubeListBuilder definitions (texOffs, addBox, PartPose) for the implemented
// mobs, baked with vanilla box-UV unwrapping, and an EntityRenderer that applies LivingEntityRenderer's
// pose (rotate 180 - bodyYaw, scale(-1,-1,1), translate(0,-1.501,0)) plus walk/head/attack animations.
import { Program, FOG_GLSL } from '../gl/util';
import { mul, rotX, rotY, rotZ, translate, scale, type M4 } from '../util/mat';
import type { FogParams } from './terrain';
import { setFog } from './terrain';
import type { GuiRenderer } from '../gui/renderer';
import { loadPng } from '../assets/bundle';

export interface Cube { u: number; v: number; x: number; y: number; z: number; w: number; h: number; d: number; inflate?: number; mirror?: boolean }
export interface Part { name: string; pivot: [number, number, number]; rot?: [number, number, number]; cubes: Cube[]; children?: Part[] }
export interface ModelDef { tex: [number, number]; parts: Part[]; kind: 'humanoid' | 'quadruped' | 'chicken' | 'creeper' | 'spider' }

const P = (name: string, pivot: [number, number, number], cubes: Cube[], rot?: [number, number, number], children?: Part[]): Part => ({ name, pivot, cubes, rot, children });
const C = (u: number, v: number, x: number, y: number, z: number, w: number, h: number, d: number, inflate = 0, mirror = false): Cube => ({ u, v, x, y, z, w, h, d, inflate, mirror });
const HALF_PI = Math.PI / 2;

/** HumanoidModel.createMesh (64x64 for zombie, 64x32 layout for skeleton arms/legs) */
function humanoid(tex: [number, number], thin: boolean): ModelDef {
  const aw = thin ? 2 : 4;
  return {
    tex, kind: 'humanoid', parts: [
      P('head', [0, 0, 0], [C(0, 0, -4, -8, -4, 8, 8, 8)]),
      P('hat', [0, 0, 0], [C(32, 0, -4, -8, -4, 8, 8, 8, 0.5)]),
      P('body', [0, 0, 0], [C(16, 16, -4, 0, -2, 8, 12, 4)]),
      P('right_arm', [-5, 2, 0], [C(40, 16, thin ? -1 : -3, -2, thin ? -1 : -2, aw, 12, aw)]),
      P('left_arm', [5, 2, 0], [tex[1] === 64 && !thin ? C(32, 48, -1, -2, -2, 4, 12, 4) : C(40, 16, -1, -2, thin ? -1 : -2, aw, 12, aw, 0, true)]),
      P('right_leg', [-1.9, 12, 0], [C(0, 16, thin ? -1 : -2, 0, thin ? -1 : -2, aw, 12, aw)]),
      P('left_leg', [1.9, 12, 0], [tex[1] === 64 && !thin ? C(16, 48, -2, 0, -2, 4, 12, 4) : C(0, 16, thin ? -1 : -2, 0, thin ? -1 : -2, aw, 12, aw, 0, true)]),
    ],
  };
}

export const MODELS: Record<string, ModelDef> = {
  zombie: humanoid([64, 64], false),
  skeleton: humanoid([64, 32], true),
  creeper: {
    tex: [64, 32], kind: 'creeper', parts: [
      P('head', [0, 6, 0], [C(0, 0, -4, -8, -4, 8, 8, 8)]),
      P('body', [0, 6, 0], [C(16, 16, -4, 0, -2, 8, 12, 4)]),
      P('right_hind_leg', [-2, 18, 4], [C(0, 16, -2, 0, -2, 4, 6, 4)]),
      P('left_hind_leg', [2, 18, 4], [C(0, 16, -2, 0, -2, 4, 6, 4)]),
      P('right_front_leg', [-2, 18, -4], [C(0, 16, -2, 0, -2, 4, 6, 4)]),
      P('left_front_leg', [2, 18, -4], [C(0, 16, -2, 0, -2, 4, 6, 4)]),
    ],
  },
  pig: {
    tex: [64, 64], kind: 'quadruped', parts: [
      P('head', [0, 12, -6], [C(0, 0, -4, -4, -8, 8, 8, 8), C(16, 16, -2, 0, -9, 4, 3, 1)]),
      P('body', [0, 11, 2], [C(28, 8, -5, -10, -7, 10, 16, 8)], [HALF_PI, 0, 0]),
      P('right_hind_leg', [-3, 18, 7], [C(0, 16, -2, 0, -2, 4, 6, 4)]),
      P('left_hind_leg', [3, 18, 7], [C(0, 16, -2, 0, -2, 4, 6, 4)]),
      P('right_front_leg', [-3, 18, -5], [C(0, 16, -2, 0, -2, 4, 6, 4)]),
      P('left_front_leg', [3, 18, -5], [C(0, 16, -2, 0, -2, 4, 6, 4)]),
    ],
  },
  cow: {
    tex: [64, 64], kind: 'quadruped', parts: [
      P('head', [0, 4, -8], [C(0, 0, -4, -4, -6, 8, 8, 6), C(1, 33, -3, 1, -7, 6, 3, 1), C(22, 0, -5, -5, -5, 1, 3, 1), C(22, 0, 4, -5, -5, 1, 3, 1, 0, true)]),
      P('body', [0, 5, 2], [C(18, 4, -6, -10, -7, 12, 18, 10), C(52, 0, -2, 2, -8, 4, 6, 1)], [HALF_PI, 0, 0]),
      P('right_hind_leg', [-4, 12, 7], [C(0, 16, -2, 0, -2, 4, 12, 4)]),
      P('left_hind_leg', [4, 12, 7], [C(0, 16, -2, 0, -2, 4, 12, 4, 0, true)]),
      P('right_front_leg', [-4, 12, -5], [C(0, 16, -2, 0, -2, 4, 12, 4)]),
      P('left_front_leg', [4, 12, -5], [C(0, 16, -2, 0, -2, 4, 12, 4, 0, true)]),
    ],
  },
  sheep: {
    tex: [64, 32], kind: 'quadruped', parts: [
      P('head', [0, 6, -8], [C(0, 0, -3, -4, -6, 6, 6, 8)]),
      P('body', [0, 5, 2], [C(28, 8, -4, -10, -7, 8, 16, 6)], [HALF_PI, 0, 0]),
      P('right_hind_leg', [-3, 12, 7], [C(0, 16, -2, 0, -2, 4, 12, 4)]),
      P('left_hind_leg', [3, 12, 7], [C(0, 16, -2, 0, -2, 4, 12, 4)]),
      P('right_front_leg', [-3, 12, -5], [C(0, 16, -2, 0, -2, 4, 12, 4)]),
      P('left_front_leg', [3, 12, -5], [C(0, 16, -2, 0, -2, 4, 12, 4)]),
    ],
  },
  sheep_wool: {
    tex: [64, 32], kind: 'quadruped', parts: [
      P('head', [0, 6, -8], [C(0, 0, -3, -4, -4, 6, 6, 6, 0.6)]),
      P('body', [0, 5, 2], [C(28, 8, -4, -10, -7, 8, 16, 6, 1.75)], [HALF_PI, 0, 0]),
      P('right_hind_leg', [-3, 12, 7], [C(0, 16, -2, 0, -2, 4, 6, 4, 0.5)]),
      P('left_hind_leg', [3, 12, 7], [C(0, 16, -2, 0, -2, 4, 6, 4, 0.5)]),
      P('right_front_leg', [-3, 12, -5], [C(0, 16, -2, 0, -2, 4, 6, 4, 0.5)]),
      P('left_front_leg', [3, 12, -5], [C(0, 16, -2, 0, -2, 4, 6, 4, 0.5)]),
    ],
  },
  chicken: {
    tex: [64, 32], kind: 'chicken', parts: [
      P('head', [0, 15, -4], [C(0, 0, -2, -6, -2, 4, 6, 3), C(14, 0, -2, -4, -4, 4, 2, 2), C(14, 4, -1, -2, -3, 2, 2, 2)]),
      P('body', [0, 16, 0], [C(0, 9, -3, -4, -3, 6, 8, 6)], [HALF_PI, 0, 0]),
      P('right_leg', [-2, 19, 1], [C(26, 0, -1, 0, -3, 3, 5, 3)]),
      P('left_leg', [1, 19, 1], [C(26, 0, -1, 0, -3, 3, 5, 3)]),
      P('right_wing', [-4, 13, 0], [C(24, 13, 0, 0, -3, 1, 4, 6)]),
      P('left_wing', [4, 13, 0], [C(24, 13, -1, 0, -3, 1, 4, 6)]),
    ],
  },
  arrow: { // ArrowModel: crossed 16x5 shafts (texture 32x32)
    tex: [32, 32], kind: 'chicken', parts: [
      P('shaft_a', [0, 24, 0], [C(0, 0, -8, -2.5, 0, 16, 5, 0)]),
      P('shaft_b', [0, 24, 0], [C(0, 0, -8, -2.5, 0, 16, 5, 0)], [HALF_PI, 0, 0]),
      P('fins', [0, 24, 0], [C(0, 5, -7, -2.5, -2.5, 0, 5, 5)]),
    ],
  },
  spider: {
    tex: [64, 32], kind: 'spider', parts: [
      P('head', [0, 15, -3], [C(32, 4, -4, -4, -8, 8, 8, 8)]),
      P('body0', [0, 15, 0], [C(0, 0, -3, -3, -3, 6, 6, 6)]),
      P('body1', [0, 15, 9], [C(0, 12, -5, -4, -6, 10, 8, 12)]),
      ...[0, 1, 2, 3].flatMap((i) => [
        P('right_leg' + i, [-4, 15, 2 - i], [C(18, 0, -15, -1, -1, 16, 2, 2)]),
        P('left_leg' + i, [4, 15, 2 - i], [C(18, 0, -1, -1, -1, 16, 2, 2)]),
      ]),
    ],
  },
};

const VS = `#version 300 es
layout(location=0) in vec3 Position; layout(location=1) in vec2 UV0; layout(location=2) in vec3 Normal;
uniform mat4 ProjMat; uniform mat4 ModelViewMat; uniform mat3 NormalMat;
uniform vec3 Light0_Direction; uniform vec3 Light1_Direction; uniform vec2 LightUV; uniform sampler2D Sampler2;
out float sphericalVertexDistance; out float cylindricalVertexDistance; out float shade; out vec4 lightMapColor; out vec2 uv;
${FOG_GLSL}
void main() {
  vec4 p = ModelViewMat * vec4(Position, 1.0); gl_Position = ProjMat * p;
  sphericalVertexDistance = fog_spherical_distance(p.xyz); cylindricalVertexDistance = fog_cylindrical_distance(p.xyz);
  vec3 n = normalize(NormalMat * Normal);
  vec2 l = max(vec2(0.0), vec2(dot(Light0_Direction, n), dot(Light1_Direction, n)));
  shade = min(1.0, (l.x + l.y) * 0.6 + 0.4);
  lightMapColor = texture(Sampler2, clamp(LightUV / 256.0 + 0.5 / 16.0, vec2(0.5 / 16.0), vec2(15.5 / 16.0)));
  uv = UV0;
}`;
const FS = `#version 300 es
precision highp float;
uniform sampler2D Sampler0; uniform vec4 Overlay; uniform vec4 ColorModulator;
in float sphericalVertexDistance; in float cylindricalVertexDistance; in float shade; in vec4 lightMapColor; in vec2 uv;
out vec4 fragColor;
${FOG_GLSL}
void main() {
  vec4 c = texture(Sampler0, uv);
  if (c.a < 0.1) discard;
  c.rgb *= shade; c *= ColorModulator;
  c.rgb = mix(Overlay.rgb, c.rgb, Overlay.a);
  c *= lightMapColor;
  fragColor = apply_fog(c, sphericalVertexDistance, cylindricalVertexDistance, FogEnvironmentalStart, FogEnvironmentalEnd, FogRenderDistanceStart, FogRenderDistanceEnd, FogColor);
}`;

interface BakedPart { name: string; pivot: number[]; rot: number[]; vao: WebGLVertexArrayObject; count: number; children: BakedPart[] }

export interface Pose { [part: string]: [number, number, number] } // extra rotation per part (radians)

export class EntityRenderer {
  private prog: Program;
  private baked = new Map<string, BakedPart[]>();
  private textures = new Map<string, WebGLTexture | null | Promise<void>>();
  constructor(readonly gl: WebGL2RenderingContext, readonly gui: GuiRenderer | null) { this.prog = new Program(gl, VS, FS, 'entity'); }

  texture(path: string): WebGLTexture | null {
    const t = this.textures.get(path);
    if (t instanceof Promise) return null;
    if (t !== undefined) return t;
    this.textures.set(path, loadPng('textures/' + path).then((img) => {
      const gl = this.gl; const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.textures.set(path, tex);
    }).catch((e) => { console.error(e); this.textures.set(path, null); }));
    return null;
  }

  /** ModelPart.Cube: box UV unwrap (texOffs u,v; sizes w,h,d) into 6 quads in model pixels. */
  private bake(def: ModelDef, key: string): BakedPart[] {
    let b = this.baked.get(key);
    if (b) return b;
    const gl = this.gl;
    const [tw, th] = def.tex;
    const bakePart = (p: Part): BakedPart => {
      const v: number[] = [];
      for (const c of p.cubes) {
        const g = c.inflate ?? 0;
        let x0 = c.x - g, y0 = c.y - g, z0 = c.z - g, x1 = c.x + c.w + g, y1 = c.y + c.h + g, z1 = c.z + c.d + g;
        if (c.mirror) [x0, x1] = [x1, x0];
        const { u, v: vv, w, h, d } = c;
        const uv = (a: number, b2: number, cc: number, dd: number) => [a / tw, b2 / th, cc / tw, dd / th];
        // [face corners (4 xyz), uv rect, normal]; vertex order gives u0v0, u1v0, u1v1, u0v1
        const faces: [number[][], number[], number[]][] = [
          [[[x1, y0, z0], [x0, y0, z0], [x0, y0, z1], [x1, y0, z1]], uv(u + d, vv, u + d + w, vv + d), [0, -1, 0]],               // up (model -y)
          [[[x1, y1, z1], [x0, y1, z1], [x0, y1, z0], [x1, y1, z0]], uv(u + d + w, vv, u + d + w + w, vv + d), [0, 1, 0]],        // down
          [[[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], uv(u + d, vv + d, u + d + w, vv + d + h), [0, 0, -1]],       // north (front)
          [[[x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]], uv(u + d + w + d, vv + d, u + d + w + d + w, vv + d + h), [0, 0, 1]], // south
          [[[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], uv(u, vv + d, u + d, vv + d + h), [1, 0, 0]],                // east (model +x = entity left)
          [[[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]], uv(u + d + w, vv + d, u + d + w + d, vv + d + h), [-1, 0, 0]], // west
        ];
        for (const [pts, r, n] of faces) {
          const tc = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
          if (c.mirror) { tc.reverse(); [tc[0], tc[1], tc[2], tc[3]] = [tc[3], tc[2], tc[1], tc[0]]; }
          for (const i of [0, 1, 2, 2, 3, 0]) v.push(pts[i][0] / 16, pts[i][1] / 16, pts[i][2] / 16, tc[i][0], tc[i][1], n[0], n[1], n[2]);
        }
      }
      const vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
      const buf = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 12);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 32, 20);
      gl.bindVertexArray(null);
      return { name: p.name, pivot: p.pivot, rot: p.rot ?? [0, 0, 0], vao, count: v.length / 8, children: (p.children ?? []).map(bakePart) };
    };
    b = def.parts.map(bakePart);
    this.baked.set(key, b);
    return b;
  }

  /**
   * Draw a model. `root` is the entity transform in view space (translate to entity, rotate body yaw).
   * hurt: red overlay; deathTime rotates the body onto its side.
   */
  draw(modelKey: string, texPath: string, proj: M4, root: M4, pose: Pose, light: [number, number], lightmap: WebGLTexture, fog: FogParams | null,
    lights: [number[], number[]], hurt: boolean, extraScale = 1, white = 0): void {
    const def = MODELS[modelKey]; const tex = this.texture(texPath);
    if (!def || !tex) return;
    const parts = this.bake(def, modelKey);
    const gl = this.gl; const p = this.prog.use();
    p.m4('ProjMat', proj);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); p.i('Sampler0', 0);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, lightmap); p.i('Sampler2', 2);
    p.v2('LightUV', light[0], light[1]);
    p.v3('Light0_Direction', lights[0][0], lights[0][1], lights[0][2]); p.v3('Light1_Direction', lights[1][0], lights[1][1], lights[1][2]);
    // OverlayTexture: red (alpha 0.7 mix) while hurt, white flash (creeper swell)
    if (hurt) p.v4('Overlay', 1, 0, 0, 1 - 0.3); else if (white > 0) p.v4('Overlay', 1, 1, 1, 1 - white); else p.v4('Overlay', 0, 0, 0, 1);
    p.v4('ColorModulator', 1, 1, 1, 1);
    if (fog) setFog(p, fog);
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.disable(gl.BLEND);
    const base = mul(root, mul(scale(-extraScale, -extraScale, extraScale), translate(0, -1.501, 0)));
    const drawPart = (bp: BakedPart, parent: M4) => {
      const extra = pose[bp.name] ?? [0, 0, 0];
      const rx = bp.rot[0] + extra[0], ry = bp.rot[1] + extra[1], rz = bp.rot[2] + extra[2];
      const m = mul(parent, mul(translate(bp.pivot[0] / 16, bp.pivot[1] / 16, bp.pivot[2] / 16), mul(rotZ((rz * 180) / Math.PI), mul(rotY((ry * 180) / Math.PI), rotX((rx * 180) / Math.PI)))));
      p.m4('ModelViewMat', m);
      gl.uniformMatrix3fv(p.loc('NormalMat'), false, upper3(m));
      gl.bindVertexArray(bp.vao); gl.drawArrays(gl.TRIANGLES, 0, bp.count);
      for (const c of bp.children) drawPart(c, m);
    };
    // the model is mirrored on x (scale -1), so faces wind clockwise
    gl.frontFace(gl.CW);
    for (const bp of parts) drawPart(bp, base);
    gl.frontFace(gl.CCW);
    gl.bindVertexArray(null);
  }
}

function upper3(m: M4): Float32Array { return new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]); }

/** Model animations (setupAnim): limb swing, head look, attack/aggressive arms. */
export function animate(kind: ModelDef['kind'], limbSwing: number, amount: number, headYaw: number, headPitch: number, age: number, extra: { aggressive?: boolean; attackTime?: number; spiderLegs?: boolean }): Pose {
  const pose: Pose = {};
  const hy = (headYaw * Math.PI) / 180, hp = (headPitch * Math.PI) / 180;
  const sw = Math.cos(limbSwing * 0.6662) * 1.4 * amount, sw2 = Math.cos(limbSwing * 0.6662 + Math.PI) * 1.4 * amount;
  if (kind === 'quadruped' || kind === 'creeper') {
    pose.head = [hp, hy, 0];
    pose.right_hind_leg = [sw, 0, 0]; pose.left_hind_leg = [sw2, 0, 0]; pose.right_front_leg = [sw2, 0, 0]; pose.left_front_leg = [sw, 0, 0];
  } else if (kind === 'humanoid') {
    pose.head = [hp, hy, 0]; pose.hat = [hp, hy, 0];
    pose.right_arm = [Math.cos(limbSwing * 0.6662 + Math.PI) * 2 * amount * 0.5, 0, 0];
    pose.left_arm = [Math.cos(limbSwing * 0.6662) * 2 * amount * 0.5, 0, 0];
    pose.right_leg = [sw, 0, 0]; pose.left_leg = [sw2, 0, 0];
    // idle arm bob (AnimationUtils.bobArms)
    pose.right_arm[2] = Math.cos(age * 0.09) * 0.05 + 0.05; pose.left_arm[2] = -(Math.cos(age * 0.09) * 0.05 + 0.05);
    pose.right_arm[0] += Math.sin(age * 0.067) * 0.05; pose.left_arm[0] -= Math.sin(age * 0.067) * 0.05;
    if (extra.aggressive) { // AnimationUtils.animateZombieArms
      const a = extra.attackTime ?? 0, f = Math.sin(a * Math.PI), g = Math.sin((1 - (1 - a) * (1 - a)) * Math.PI);
      const r = -Math.PI / 2.25;
      pose.right_arm = [r + f * 1.2 - g * 0.4, 0.1 - f * 0.6, pose.right_arm[2]];
      pose.left_arm = [r + f * 1.2 - g * 0.4, -0.1 + f * 0.6, pose.left_arm[2]];
    }
  } else if (kind === 'chicken') {
    pose.head = [hp, hy, 0];
    pose.right_leg = [Math.cos(limbSwing * 0.6662) * 1.4 * amount, 0, 0]; pose.left_leg = [Math.cos(limbSwing * 0.6662 + Math.PI) * 1.4 * amount, 0, 0];
    const flap = (Math.sin(age * 0.5) + 1) * (amount > 0.05 ? 1 : 0.2);
    pose.right_wing = [0, 0, flap]; pose.left_wing = [0, 0, -flap];
  } else if (kind === 'spider') {
    pose.head = [hp, hy, 0];
    const q = Math.PI / 4;
    for (let i = 0; i < 4; i++) {
      const zb = i === 0 || i === 3 ? q : q * 0.74, yb = [q, q / 2, -q / 2, -q][i];
      const ph = [0, Math.PI, Math.PI / 2, Math.PI * 1.5][i];
      const ys = -(Math.cos(limbSwing * 0.6662 * 2 + ph) * 0.4) * amount, zs = Math.abs(Math.sin(limbSwing * 0.6662 + ph) * 0.4) * amount;
      pose['right_leg' + i] = [0, yb + ys, -zb + zs];
      pose['left_leg' + i] = [0, -yb - ys, zb - zs];
    }
  }
  return pose;
}
