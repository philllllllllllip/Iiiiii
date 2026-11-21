// View frustum from a projection*view matrix (Gribb/Hartmann plane extraction), AABB test.
export class Frustum {
  private p = new Float32Array(24);
  set(m: Float32Array): void {
    const p = this.p;
    const row = (i: number) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
    const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
    const planes = [
      r3.map((v, i) => v + r0[i]), r3.map((v, i) => v - r0[i]), r3.map((v, i) => v + r1[i]),
      r3.map((v, i) => v - r1[i]), r3.map((v, i) => v + r2[i]), r3.map((v, i) => v - r2[i]),
    ];
    planes.forEach((pl, i) => p.set(pl, i * 4));
  }
  /** Box in camera-relative coordinates. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    const p = this.p;
    for (let i = 0; i < 24; i += 4) {
      const x = p[i] >= 0 ? x1 : x0, y = p[i + 1] >= 0 ? y1 : y0, z = p[i + 2] >= 0 ? z1 : z0;
      if (p[i] * x + p[i + 1] * y + p[i + 2] * z + p[i + 3] < 0) return false;
    }
    return true;
  }
}
