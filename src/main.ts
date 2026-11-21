// Phase 2 entry: load the 26.3 bundle, build + light + mesh the test scene, render with sky, clouds,
// fog and lightmap. Controls: click to capture mouse, WASD/Space/Shift to fly, [ ] change time,
// T toggles time flow. URL params: ?time=<ticks>&x=&y=&z=&yaw=&pitch= for reproducible screenshots.
import { loadBundle, loadPng } from './assets/bundle';
import { BlockRegistry } from './world/registry';
import { BlockInfo } from './world/blockinfo';
import { Biomes } from './world/biomes';
import { World } from './world/world';
import { LightEngine } from './world/light';
import { Mesher } from './mesh/mesher';
import { BlockTextures } from './render/blocktextures';
import { TerrainRenderer, type FogParams } from './render/terrain';
import { SkyRenderer } from './render/sky';
import { CloudRenderer } from './render/clouds';
import { Lightmap } from './render/lightmap';
import { Environment } from './env/timeline';
import { quadIndexBuffer } from './gl/util';
import { perspective, viewRotation } from './util/mat';
import { buildTestScene } from './demo/testscene';
import { MIN_Y, SECTIONS } from './world/chunk';

const RENDER_DISTANCE = 12;

function fatal(e: unknown): void {
  const el = document.getElementById('fatal')!;
  el.style.display = 'block';
  el.textContent = String(e instanceof Error ? e.stack ?? e.message : e);
  console.error(e);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 is required');
  const b = await loadBundle();
  const clouds = await loadPng('textures/environment/clouds.png');

  const reg = new BlockRegistry(b.blocks);
  const info = new BlockInfo(reg, b.models, b.blocks);
  const biomes = new Biomes(b.worldgen, b.grassColormap, b.foliageColormap, b.dryFoliageColormap);
  const plains = biomes.id('plains');
  const env = new Environment(b.timelines as any, b.dimensionTypes['overworld']);

  const textures = new BlockTextures(gl, b.blockAtlas, b.blockAtlasImage);
  // liquids are drawn by LiquidBlockRenderer, not models: their sprites are appended to the slot table
  const spriteNames = [...b.models.sprites, 'block/water_still', 'block/water_flow', 'block/water_overlay', 'block/lava_still', 'block/lava_flow'];
  const mesher = new Mesher(reg, info, biomes, b.blocks, textures.slotTable(spriteNames), spriteNames, { smoothLighting: true, biomeBlend: 2 });
  const world = new World();
  buildTestScene(world, reg, plains);
  const light = new LightEngine(world, info);
  for (const c of world.chunks.values()) { for (let i = 0; i < SECTIONS; i++) c.recountSection(i); }
  for (const c of world.chunks.values()) light.lightChunk(c);

  const terrain = new TerrainRenderer(gl, quadIndexBuffer(gl, 1 << 18));
  const t0 = performance.now();
  let quads = 0;
  for (const c of world.chunks.values()) for (let s = 0; s < SECTIONS; s++) {
    if (c.sections[s].nonAir === 0) continue;
    const sy = s + MIN_Y / 16;
    const mesh = mesher.meshSection(world, c.cx, sy, c.cz);
    quads += mesh.quads[0] + mesh.quads[1] + mesh.quads[2];
    terrain.upload((c.cx + 512) * 1048576 + (c.cz + 512) * 64 + s, c.cx, sy, c.cz, mesh);
  }
  console.log(`meshed ${terrain.sections.size} sections, ${quads} quads in ${(performance.now() - t0).toFixed(0)} ms`);
  world.dirtySections.clear();

  const sky = new SkyRenderer(gl, b.celestialAtlas, b.celestialAtlasImage);
  const cloudR = new CloudRenderer(gl, clouds);
  const lightmap = new Lightmap(gl);

  // camera
  const q = new URLSearchParams(location.search);
  const cam = { x: +(q.get('x') ?? 4.5), y: +(q.get('y') ?? 70), z: +(q.get('z') ?? 22), yaw: +(q.get('yaw') ?? 180), pitch: +(q.get('pitch') ?? 20) };
  let gameTime = +(q.get('time') ?? 6000);
  let timeFlows = q.get('freeze') === null;
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (e.code === 'BracketRight') gameTime += 1000;
    if (e.code === 'BracketLeft') gameTime -= 1000;
    if (e.code === 'KeyT') timeFlows = !timeFlows;
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  canvas.addEventListener('click', () => canvas.requestPointerLock());
  window.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    cam.yaw += e.movementX * 0.15; cam.pitch = Math.max(-90, Math.min(90, cam.pitch + e.movementY * 0.15));
  });

  const resize = () => {
    canvas.width = Math.floor(innerWidth * devicePixelRatio); canvas.height = Math.floor(innerHeight * devicePixelRatio);
  };
  window.addEventListener('resize', resize); resize();

  let last = performance.now(); let tickAcc = 0;
  (window as any).__mc = { cam, get time() { return gameTime; }, set time(v: number) { gameTime = v; }, ready: false, frames: 0 };

  const frame = (now: number) => {
    const dt = Math.min(0.25, (now - last) / 1000); last = now;
    tickAcc += dt * 20;
    while (tickAcc >= 1) { tickAcc -= 1; if (timeFlows) gameTime++; textures.tick(); lightmap.tick(); }
    const partial = tickAcc;
    // fly
    const sp = (keys.has('ControlLeft') ? 20 : 10) * dt;
    const yr = (cam.yaw * Math.PI) / 180;
    const fx = -Math.sin(yr), fz = Math.cos(yr);
    if (keys.has('KeyW')) { cam.x += fx * sp; cam.z += fz * sp; }
    if (keys.has('KeyS')) { cam.x -= fx * sp; cam.z -= fz * sp; }
    if (keys.has('KeyA')) { cam.x += fz * sp; cam.z -= fx * sp; }
    if (keys.has('KeyD')) { cam.x -= fz * sp; cam.z += fx * sp; }
    if (keys.has('Space')) cam.y += sp;
    if (keys.has('ShiftLeft')) cam.y -= sp;

    const t = gameTime + partial;
    const bAttrs = biomes.list[plains].attributes;
    const skyCol = env.color('minecraft:visual/sky_color', t, bAttrs);
    const fogBase = env.color('minecraft:visual/fog_color', t, bAttrs);
    const sunrise = env.color('minecraft:visual/sunrise_sunset_color', t, bAttrs);
    const sunAngle = env.num('minecraft:visual/sun_angle', t, bAttrs);
    // FogRenderer: blend fog toward sky colour by render distance, then toward sunrise when facing the sun
    const rdf = 1 - Math.pow(0.25 + (0.75 * RENDER_DISTANCE) / 32, 0.25);
    const fog = fogBase.slice(0, 3).map((v, i) => v + (skyCol[i] - v) * rdf);
    const pr = (cam.pitch * Math.PI) / 180;
    const look = [-Math.sin(yr) * Math.cos(pr), -Math.sin(pr), Math.cos(yr) * Math.cos(pr)];
    const sunDir = Math.sin((sunAngle * Math.PI) / 180) > 0 ? [-1, 0, 0] : [1, 0, 0];
    const dot = look[0] * sunDir[0] + look[1] * sunDir[1] + look[2] * sunDir[2];
    if (dot > 0 && sunrise[3] > 0) for (let i = 0; i < 3; i++) fog[i] += (sunrise[i] - fog[i]) * dot * sunrise[3];

    const rd = RENDER_DISTANCE * 16;
    const fogP: FogParams = {
      color: [fog[0], fog[1], fog[2], 1],
      envStart: 1e9, envEnd: 1e9 + 1,
      rdStart: rd - Math.min(64, Math.max(4, rd / 10)), rdEnd: rd,
      skyEnd: env.num('minecraft:visual/sky_fog_end_distance', t, bAttrs), cloudsEnd: env.num('minecraft:visual/cloud_fog_end_distance', t, bAttrs),
    };
    const blockTint = env.color('minecraft:visual/block_light_tint', t, bAttrs);
    lightmap.update({
      skyFactor: env.num('minecraft:visual/sky_light_factor', t, bAttrs), blockFactor: lightmap.blockFactor,
      nightVisionFactor: 0, darknessScale: 0, bossOverlayDarkening: 0, brightnessFactor: 0.5,
      blockLightTint: blockTint, skyLightColor: env.color('minecraft:visual/sky_light_color', t, bAttrs),
      ambientColor: env.color('minecraft:visual/ambient_light_color', t, bAttrs), nightVisionColor: env.color('minecraft:visual/night_vision_color', t, bAttrs),
    });

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(fog[0], fog[1], fog[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const proj = perspective(70, canvas.width / canvas.height, 0.05, Math.max(rd * 4, 1024));
    const view = viewRotation(cam.yaw, cam.pitch);
    sky.draw(proj, view, {
      skyColor: skyCol, sunriseColor: sunrise, sunAngle,
      moonAngle: env.num('minecraft:visual/moon_angle', t, bAttrs), starAngle: env.num('minecraft:visual/star_angle', t, bAttrs),
      starBrightness: env.num('minecraft:visual/star_brightness', t, bAttrs), moonPhase: String(env.get('minecraft:visual/moon_phase', t, bAttrs)),
      rain: 0, belowHorizon: cam.y - 63 < 0,
    }, fogP);
    terrain.draw(proj, view, [cam.x, cam.y, cam.z], fogP, textures.arrays, lightmap.tex, () => true);
    const cc = env.color('minecraft:visual/cloud_color', t, bAttrs);
    cloudR.draw(proj, view, [cam.x, cam.y, cam.z], gameTime, partial, env.num('minecraft:visual/cloud_height', t, bAttrs), [cc[0], cc[1], cc[2], cc[3]], fogP);
    (window as any).__mc.ready = true; (window as any).__mc.frames++;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch(fatal);
