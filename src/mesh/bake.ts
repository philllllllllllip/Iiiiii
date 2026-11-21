// Bakes block models into quads, following vanilla FaceBakery / BlockModelRotation:
//  * FaceInfo vertex order per direction
//  * BlockFaceUV index shifting for face `rotation`
//  * element rotation about an origin (axis/angle with optional rescale, or 26.3 Euler x/y/z)
//  * variant rotation (x then y, about the block centre) with optional uvlock
// Positions are in block units [0,1]; UVs are normalised to the sprite [0,1].
import type { Dir, Model, ModelElement, PartChoice } from '../assets/types';

export const DIR_INDEX: Record<Dir, number> = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };
export const DIRS: Dir[] = ['down', 'up', 'north', 'south', 'west', 'east'];
export const DIR_VEC: [number, number, number][] = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
export const OPPOSITE = [1, 0, 3, 2, 5, 4];

export interface BakedQuad {
  /** 4 vertices x (x,y,z) block units */
  pos: Float32Array;
  /** 4 vertices x (u,v), sprite normalised */
  uv: Float32Array;
  sprite: number;
  tint: number; // -1 none
  dir: number; // face direction (after rotation), for AO / culling geometry
  shadeDir: number; // direction whose shade value is used (shade_direction_override, else dir)
  cull: number; // -1 none, else direction index (after rotation)
  shade: boolean;
  light: number; // element light emission 0..15
  translucent: boolean;
  /** quad spans the whole face and sits on the block boundary (greedy-mergeable, cubic AO) */
  fullFace: boolean;
  /** plane lies on the block boundary in `dir` (AO samples the neighbour) */
  onBoundary: boolean;
  ao: boolean;
}

// FaceInfo: vertex corner selection per direction. Each vertex: [xMax?, yMax?, zMax?]
const FACE_INFO: [number, number, number][][] = [
  /* down  */ [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]],
  /* up    */ [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  /* north */ [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]],
  /* south */ [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]],
  /* west  */ [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]],
  /* east  */ [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]],
];

type Mat3 = number[]; // row-major 3x3

function matMul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}
function rotX(deg: number): Mat3 { const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180); return [1, 0, 0, 0, c, -s, 0, s, c]; }
function rotY(deg: number): Mat3 { const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180); return [c, 0, s, 0, 1, 0, -s, 0, c]; }
function rotZ(deg: number): Mat3 { const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180); return [c, -s, 0, s, c, 0, 0, 0, 1]; }
function apply(m: Mat3, v: number[]): number[] {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}
const snap = (v: number) => { const r = Math.round(v * 16) / 16; return Math.abs(r - v) < 1e-5 ? r : v; };

function nearestDir(n: number[]): number {
  let best = 0, bd = -Infinity;
  for (let i = 0; i < 6; i++) { const d = DIR_VEC[i][0] * n[0] + DIR_VEC[i][1] * n[1] + DIR_VEC[i][2] * n[2]; if (d > bd) { bd = d; best = i; } }
  return best;
}

/** Element rotation (vanilla BlockElementRotation): rotate about origin, rescale other axes by 1/cos. */
function elementTransform(el: ModelElement): ((p: number[]) => number[]) | null {
  const r = el.rotation;
  if (!r) return null;
  const o = r.origin.map((v) => v / 16);
  let m: Mat3; let scale = [1, 1, 1];
  if (r.axis) {
    const a = r.angle ?? 0;
    if (a === 0) return null;
    // Vanilla rotates by -angle around x? No: axis rotation uses positive angle around the named axis.
    m = r.axis === 'x' ? rotX(a) : r.axis === 'y' ? rotY(a) : rotZ(a);
    if (r.rescale) {
      const f = 1 / Math.cos(Math.abs(a) * Math.PI / 180);
      scale = r.axis === 'x' ? [1, f, f] : r.axis === 'y' ? [f, 1, f] : [f, f, 1];
    }
  } else {
    // 26.3 Euler rotation, applied X then Y then Z (XYZ order)
    m = matMul(rotZ(r.z ?? 0), matMul(rotY(r.y ?? 0), rotX(r.x ?? 0)));
  }
  return (p) => {
    const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    const q = apply(m, d);
    return [q[0] * scale[0] + o[0], q[1] * scale[1] + o[1], q[2] * scale[2] + o[2]];
  };
}

/** Variant rotation: BlockModelRotation applies X then Y (both negative angles, about the block centre). */
function variantMatrix(x: number, y: number): Mat3 {
  return matMul(rotY(-y), rotX(-x));
}

/** uvlock: project world-space vertex onto the face plane with the default (unrotated) UV convention. */
function uvLockUv(dir: number, p: number[]): [number, number] {
  switch (dir) {
    case 0: return [p[0], 1 - p[2]];
    case 1: return [p[0], p[2]];
    case 2: return [1 - p[0], 1 - p[1]];
    case 3: return [p[0], 1 - p[1]];
    case 4: return [p[2], 1 - p[1]];
    default: return [1 - p[2], 1 - p[1]];
  }
}

export function bakeChoice(model: Model, choice: PartChoice): BakedQuad[] {
  const quads: BakedQuad[] = [];
  const vx = choice.x ?? 0, vy = choice.y ?? 0;
  const vm = vx || vy ? variantMatrix(vx, vy) : null;
  const rotP = (p: number[]) => { if (!vm) return p; const q = apply(vm, [p[0] - 0.5, p[1] - 0.5, p[2] - 0.5]); return [snap(q[0] + 0.5), snap(q[1] + 0.5), snap(q[2] + 0.5)]; };
  const rotD = (d: number) => (vm ? nearestDir(apply(vm, DIR_VEC[d])) : d);
  for (const el of model.elements) {
    const et = elementTransform(el);
    const from = el.from.map((v) => v / 16), to = el.to.map((v) => v / 16);
    for (let di = 0; di < 6; di++) {
      const f = el.faces[DIRS[di]];
      if (!f) continue;
      const pos = new Float32Array(12), uv = new Float32Array(8);
      const [u0, v0, u1, v1] = f.uv.map((v) => v / 16);
      const shift = ((f.rot ?? 0) / 90) | 0;
      const world: number[][] = [];
      for (let i = 0; i < 4; i++) {
        const c = FACE_INFO[di][i];
        let p = [c[0] ? to[0] : from[0], c[1] ? to[1] : from[1], c[2] ? to[2] : from[2]];
        if (et) p = et(p);
        p = rotP(p);
        world.push(p);
        pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
        const si = (i + shift) % 4;
        uv[i * 2] = si === 0 || si === 1 ? u0 : u1;
        uv[i * 2 + 1] = si === 0 || si === 3 ? v0 : v1;
      }
      // Face normal from the transformed geometry
      const e1 = [world[1][0] - world[0][0], world[1][1] - world[0][1], world[1][2] - world[0][2]];
      const e2 = [world[2][0] - world[1][0], world[2][1] - world[1][1], world[2][2] - world[1][2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      // Degenerate (zero-area, e.g. flat elements' side faces): fall back to the face's nominal direction.
      const len = Math.hypot(n[0], n[1], n[2]);
      const dir = len < 1e-9 ? rotD(di) : nearestDir(n);
      if (choice.uvlock && vm) {
        for (let i = 0; i < 4; i++) {
          const [lu, lv] = uvLockUv(dir, world[i]);
          uv[i * 2] = lu; uv[i * 2 + 1] = lv;
        }
        if (shift) {
          const copy = uv.slice();
          for (let i = 0; i < 4; i++) { const j = (i + shift) % 4; uv[i * 2] = copy[j * 2]; uv[i * 2 + 1] = copy[j * 2 + 1]; }
        }
      }
      const axis = dir >> 1; // 0:y 1:z 2:x
      const ax = axis === 0 ? 1 : axis === 1 ? 2 : 0;
      const plane = world[0][ax];
      const coplanar = world.every((p) => Math.abs(p[ax] - plane) < 1e-6);
      const boundaryVal = dir & 1 ? 1 : 0;
      const onBoundary = coplanar && Math.abs(plane - boundaryVal) < 1e-6;
      const o1 = ax === 0 ? 1 : 0, o2 = ax === 2 ? 1 : 2;
      let mn1 = 1, mx1 = 0, mn2 = 1, mx2 = 0;
      for (const p of world) { mn1 = Math.min(mn1, p[o1]); mx1 = Math.max(mx1, p[o1]); mn2 = Math.min(mn2, p[o2]); mx2 = Math.max(mx2, p[o2]); }
      const fullFace = onBoundary && mn1 <= 1e-6 && mn2 <= 1e-6 && mx1 >= 1 - 1e-6 && mx2 >= 1 - 1e-6;
      quads.push({
        pos, uv, sprite: f.tex, tint: f.tint ?? -1, dir, shadeDir: el.shadeDir ? rotD(DIR_INDEX[el.shadeDir]) : dir,
        cull: f.cull ? rotD(DIR_INDEX[f.cull]) : -1,
        shade: el.shade !== false,
        light: el.light ?? 0,
        translucent: !!f.translucent,
        fullFace, onBoundary, ao: model.ao,
      });
    }
  }
  return quads;
}

