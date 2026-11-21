// LevelRenderer equivalent: environment (timeline attributes), lightmap, fog, sky, terrain, clouds.
import type { Bundle } from '../assets/bundle';
import { BlockTextures } from './blocktextures';
import { TerrainRenderer, type FogParams } from './terrain';
import { SkyRenderer } from './sky';
import { CloudRenderer } from './clouds';
import { Lightmap } from './lightmap';
import { Frustum } from './frustum';
import { Environment } from '../env/timeline';
import { quadIndexBuffer } from '../gl/util';
import { perspective, viewRotation, mul, type M4 } from '../util/mat';
import type { RGBAImage } from '../assets/png';
import type { Biomes } from '../world/biomes';

export interface Camera { x: number; y: number; z: number; yaw: number; pitch: number; fov: number; roll?: number; bob?: M4 }

export interface RenderOptions { renderDistance: number; gamma: number; clouds: 'off' | 'fast' | 'fancy'; cloudRange?: number; shadows?: boolean }

export class WorldRenderer {
  readonly textures: BlockTextures;
  readonly terrain: TerrainRenderer;
  readonly sky: SkyRenderer;
  readonly clouds: CloudRenderer;
  readonly lightmap: Lightmap;
  env: Environment;
  dimension: 'overworld' | 'the_nether' | 'the_end' = 'overworld';
  endSky: RGBAImage | null = null;
  private bundle: Bundle;
  private frustum = new Frustum();
  proj: M4 = new Float32Array(16);
  view: M4 = new Float32Array(16);
  fogColor: number[] = [0, 0, 0];
  lastFog: FogParams | null = null;
  sectionsDrawn = 0;
  /** extra darkening/overlay state set by the game */
  underwater = false;
  rain = 0;

  constructor(readonly gl: WebGL2RenderingContext, b: Bundle, cloudsTex: RGBAImage, readonly biomes: Biomes) {
    this.textures = new BlockTextures(gl, b.blockAtlas, b.blockAtlasImage);
    this.terrain = new TerrainRenderer(gl, quadIndexBuffer(gl, 1 << 18));
    this.sky = new SkyRenderer(gl, b.celestialAtlas, b.celestialAtlasImage);
    this.clouds = new CloudRenderer(gl, cloudsTex);
    this.lightmap = new Lightmap(gl);
    this.env = new Environment(b.timelines as any, b.dimensionTypes['overworld']);
    this.bundle = b;
  }

  setDimension(dim: 'overworld' | 'the_nether' | 'the_end', endSky?: RGBAImage): void {
    this.dimension = dim;
    this.env = new Environment(this.bundle.timelines as any, this.bundle.dimensionTypes[dim]);
    if (endSky) this.endSky = endSky;
  }

  tick(): void { this.textures.tick(); this.lightmap.tick(); }

  /** Render the world. `biome` is the biome at the camera (attributes for sky/fog). */
  render(cam: Camera, gameTime: number, partial: number, biome: number, opts: RenderOptions, width: number, height: number): void {
    const gl = this.gl, env = this.env;
    const t = gameTime + partial;
    const bAttrs = this.biomes.list[biome]?.attributes ?? {};
    const skyCol = env.color('minecraft:visual/sky_color', t, bAttrs);
    const fogBase = env.color('minecraft:visual/fog_color', t, bAttrs);
    const sunrise = env.color('minecraft:visual/sunrise_sunset_color', t, bAttrs);
    const sunAngle = env.num('minecraft:visual/sun_angle', t, bAttrs);
    const rdChunks = opts.renderDistance;
    const rd = rdChunks * 16;
    let fog: number[];
    let fogP: FogParams;
    if (this.dimension !== 'overworld') {
      fog = fogBase.slice(0, 3);
      const nether = this.dimension === 'the_nether';
      fogP = {
        color: [fog[0], fog[1], fog[2], 1],
        envStart: nether ? env.num('minecraft:visual/fog_start_distance', t, bAttrs) : 1e9, envEnd: nether ? env.num('minecraft:visual/fog_end_distance', t, bAttrs) : 1e9 + 1,
        rdStart: rd - Math.min(64, Math.max(4, rd / 10)), rdEnd: rd, skyEnd: rd, cloudsEnd: 0,
      };
    } else if (this.underwater) {
      const wf = env.color('minecraft:visual/water_fog_color', t, bAttrs);
      fog = [wf[0], wf[1], wf[2]];
      fogP = { color: [fog[0], fog[1], fog[2], 1], envStart: env.num('minecraft:visual/water_fog_start_distance', t, bAttrs), envEnd: env.num('minecraft:visual/water_fog_end_distance', t, bAttrs), rdStart: rd, rdEnd: rd, skyEnd: rd, cloudsEnd: 0 };
    } else {
      // FogRenderer: blend towards the sky colour by render distance, then towards sunrise colour when facing the sun
      const rdf = 1 - Math.pow(0.25 + (0.75 * rdChunks) / 32, 0.25);
      fog = fogBase.slice(0, 3).map((v, i) => v + (skyCol[i] - v) * rdf);
      const yr = (cam.yaw * Math.PI) / 180, pr = (cam.pitch * Math.PI) / 180;
      const look = [-Math.sin(yr) * Math.cos(pr), -Math.sin(pr), Math.cos(yr) * Math.cos(pr)];
      const sunDir = Math.sin((sunAngle * Math.PI) / 180) > 0 ? [-1, 0, 0] : [1, 0, 0];
      const dot = look[0] * sunDir[0] + look[1] * sunDir[1] + look[2] * sunDir[2];
      if (dot > 0 && sunrise[3] > 0) for (let i = 0; i < 3; i++) fog[i] += (sunrise[i] - fog[i]) * dot * sunrise[3];
      if (this.rain > 0) { const g = 1 - this.rain * 0.5; for (let i = 0; i < 3; i++) fog[i] *= g; }
      fogP = {
        color: [fog[0], fog[1], fog[2], 1], envStart: 1e9, envEnd: 1e9 + 1,
        rdStart: rd - Math.min(64, Math.max(4, rd / 10)), rdEnd: rd,
        skyEnd: Math.min(rd, env.num('minecraft:visual/sky_fog_end_distance', t, bAttrs)), cloudsEnd: env.num('minecraft:visual/cloud_fog_end_distance', t, bAttrs),
      };
    }
    // void darkening below the horizon (FogRenderer: darken fog colour when the camera is below y=63)
    if (cam.y < 63 && !this.underwater && this.dimension === 'overworld') {
      const d = Math.max(0, Math.min(1, (cam.y - (-64)) / (63 - -64)));
      for (let i = 0; i < 3; i++) fog[i] *= d * d;
      fogP.color = [fog[0], fog[1], fog[2], 1];
    }
    this.fogColor = fog; this.lastFog = fogP;
    this.lightmap.update({
      skyFactor: env.num('minecraft:visual/sky_light_factor', t, bAttrs) * (1 - this.rain * 0.3125), blockFactor: this.lightmap.blockFactor,
      nightVisionFactor: 0, darknessScale: 0, bossOverlayDarkening: 0, brightnessFactor: opts.gamma,
      blockLightTint: env.color('minecraft:visual/block_light_tint', t, bAttrs), skyLightColor: env.color('minecraft:visual/sky_light_color', t, bAttrs),
      ambientColor: env.color('minecraft:visual/ambient_light_color', t, bAttrs), nightVisionColor: env.color('minecraft:visual/night_vision_color', t, bAttrs),
    });
    gl.viewport(0, 0, width, height);
    gl.clearColor(fog[0], fog[1], fog[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.proj = perspective(cam.fov, width / height, 0.05, Math.max(rd * 4, 1024));
    let view = viewRotation(cam.yaw, cam.pitch);
    if (cam.bob) view = mul(cam.bob, view);
    this.view = view;
    if (this.dimension === 'the_end' && this.endSky) this.sky.drawEnd(this.proj, view, this.endSky);
    else if (!this.underwater && this.dimension === 'overworld') this.sky.draw(this.proj, view, {
      skyColor: skyCol, sunriseColor: sunrise, sunAngle,
      moonAngle: env.num('minecraft:visual/moon_angle', t, bAttrs), starAngle: env.num('minecraft:visual/star_angle', t, bAttrs),
      starBrightness: env.num('minecraft:visual/star_brightness', t, bAttrs), moonPhase: String(env.get('minecraft:visual/moon_phase', t, bAttrs)),
      rain: this.rain, belowHorizon: cam.y - 63 < 0,
    }, fogP);
    this.frustum.set(mul(this.proj, view));
    // optional sun shadow cascade (not vanilla): ortho box around the camera, range tied to render distance
    this.terrain.shadowsOn = !!opts.shadows && this.dimension === 'overworld';
    if (this.terrain.shadowsOn) {
      const sunUp = Math.cos((sunAngle * Math.PI) / 180);
      const R = Math.min(rd, 128);
      // sun direction = rotY(-90)·rotX(sunAngle)·(0,1,0) = (-sin a, cos a, 0); at night use the moon (opposite)
      const ar = (sunAngle * Math.PI) / 180;
      let bx = -Math.sin(ar), by = Math.cos(ar);
      if (sunUp < 0) { bx = -bx; by = -by; }
      // view basis: right=(0,0,1), up=(by,-bx,0), back=light direction; ortho half-extent R, depth ±256
      const texel = (2 * R) / 2048;
      const ux = by, uy = -bx;
      const mat = new Float32Array(16);
      mat[2] = -bx / 256; mat[6] = -by / 256; mat[10] = 0; mat[14] = 0;
      mat[0] = 0; mat[4] = 0; mat[8] = 1 / R;
      mat[1] = ux / R; mat[5] = uy / R; mat[9] = 0;
      mat[15] = 1;
      // snap the camera-relative origin to whole shadow texels so edges do not crawl while moving
      const ox = cam.z, oy = ux * cam.x + uy * cam.y;
      mat[12] = (ox - Math.floor(ox / texel) * texel) / R;
      mat[13] = (oy - Math.floor(oy / texel) * texel) / R;
      // snap to texels to keep shadows stable while moving
      this.terrain.shadow && (this.terrain.shadow.strength = 0.45 * Math.min(1, Math.abs(sunUp) * 4) * (sunUp < 0 ? 0.3 : 1));
      this.terrain.renderShadow(mat, [cam.x, cam.y, cam.z], this.textures.arrays, (s) => Math.abs(s.x + 8 - cam.x) < R + 16 && Math.abs(s.z + 8 - cam.z) < R + 16);
      gl.viewport(0, 0, width, height);
    }
    const cp: [number, number, number] = [cam.x, cam.y, cam.z];
    const maxD2 = (rd + 24) * (rd + 24);
    this.terrain.frustumBox = (x, y, z) => this.frustum.box(x, y, z, x + 16, y + 16, z + 16) && (x + 8) * (x + 8) + (z + 8) * (z + 8) <= maxD2;
    this.sectionsDrawn = this.terrain.draw(this.proj, view, cp, fogP, this.textures.arrays, this.lightmap.tex, (s) => {
      const x0 = s.x - cam.x, y0 = s.y - cam.y, z0 = s.z - cam.z;
      const dx = x0 + 8, dz = z0 + 8;
      if (dx * dx + dz * dz > maxD2) return false;
      return this.frustum.box(x0, y0, z0, x0 + 16, y0 + 16, z0 + 16);
    });
    if (opts.clouds !== 'off' && this.dimension === 'overworld') {
      const cc = env.color('minecraft:visual/cloud_color', t, bAttrs);
      this.clouds.draw(this.proj, view, cp, gameTime, partial, env.num('minecraft:visual/cloud_height', t, bAttrs), [cc[0] * (1 - this.rain * 0.5), cc[1] * (1 - this.rain * 0.5), cc[2] * (1 - this.rain * 0.5), cc[3]], fogP);
    }
  }
}
