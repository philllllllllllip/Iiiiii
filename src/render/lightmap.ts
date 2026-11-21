// LightTexture: port of 26.3 core/lightmap.fsh evaluated on the CPU into a 16x16 RGBA texture.
import { JavaRandom } from '../util/javarandom';

export interface LightmapInfo {
  skyFactor: number; blockFactor: number; nightVisionFactor: number; darknessScale: number;
  bossOverlayDarkening: number; brightnessFactor: number;
  blockLightTint: number[]; skyLightColor: number[]; ambientColor: number[]; nightVisionColor: number[];
}

const getBrightness = (l: number) => l / (4 - 3 * l);
const parabolic = (l: number) => (2 * l - 1) * (2 * l - 1);

export function computeLightmap(info: LightmapInfo, out: Uint8Array): void {
  for (let sky = 0; sky < 16; sky++) for (let block = 0; block < 16; block++) {
    const bl = block / 15, sl = sky / 15;
    const bb = getBrightness(bl) * info.blockFactor, sb = getBrightness(sl) * info.skyFactor;
    const c = [0, 1, 2].map((i) => Math.max(info.ambientColor[i], info.nightVisionColor[i] * info.nightVisionFactor));
    for (let i = 0; i < 3; i++) c[i] += info.skyLightColor[i] * sb;
    const mixf = 0.9 * parabolic(bl);
    for (let i = 0; i < 3; i++) c[i] += (info.blockLightTint[i] + (1 - info.blockLightTint[i]) * mixf) * bb;
    const dark = [0.7, 0.6, 0.6];
    for (let i = 0; i < 3; i++) { c[i] = c[i] + (c[i] * dark[i] - c[i]) * info.bossOverlayDarkening; c[i] -= info.darknessScale; c[i] = Math.min(1, Math.max(0, c[i])); }
    const mx = Math.max(c[0], c[1], c[2]);
    const inv = 1 - mx; const scaled = 1 - inv * inv * inv * inv;
    for (let i = 0; i < 3; i++) {
      const ng = mx > 0 ? c[i] * (scaled / mx) : 0;
      c[i] = c[i] + (ng - c[i]) * info.brightnessFactor;
    }
    const o = (sky * 16 + block) * 4;
    out[o] = Math.round(c[0] * 255); out[o + 1] = Math.round(c[1] * 255); out[o + 2] = Math.round(c[2] * 255); out[o + 3] = 255;
  }
}

export class Lightmap {
  readonly tex: WebGLTexture;
  private px = new Uint8Array(16 * 16 * 4);
  private flicker = 0;
  private rng = new JavaRandom(BigInt(Date.now()));
  constructor(readonly gl: WebGL2RenderingContext) {
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 16, 16);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  /** LightTexture.tick: block light flicker random walk. */
  tick(): void {
    const r = this.rng;
    this.flicker += (r.nextFloat() - r.nextFloat()) * r.nextFloat() * r.nextFloat() * 0.1;
    this.flicker *= 0.9;
  }
  get blockFactor(): number { return this.flicker + 1.5; }
  update(info: LightmapInfo): void {
    computeLightmap(info, this.px);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, this.px);
  }
}
