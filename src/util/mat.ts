// Column-major 4x4 matrices (WebGL convention).
export type M4 = Float32Array;
export const identity = (): M4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
export function mul(a: M4, b: M4): M4 {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + rr] * b[c * 4 + k];
    r[c * 4 + rr] = s;
  }
  return r;
}
export function perspective(fovYDeg: number, aspect: number, near: number, far: number): M4 {
  const f = 1 / Math.tan((fovYDeg * Math.PI) / 360);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1; m[14] = (2 * far * near) / (near - far);
  return m;
}
export function rotX(deg: number): M4 { const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180); return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]); }
export function rotY(deg: number): M4 { const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180); return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); }
export function rotZ(deg: number): M4 { const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180); return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }
export function translate(x: number, y: number, z: number): M4 { const m = identity(); m[12] = x; m[13] = y; m[14] = z; return m; }
export function scale(x: number, y: number, z: number): M4 { const m = identity(); m[0] = x; m[5] = y; m[10] = z; return m; }
/** Vanilla camera view rotation: pitch about X, then yaw+180 about Y (Minecraft yaw: 0 = +Z/south). */
export function viewRotation(yaw: number, pitch: number): M4 {
  return mul(rotX(pitch), rotY(yaw + 180));
}
