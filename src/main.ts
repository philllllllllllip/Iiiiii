// Phase 3 entry: stream a generated world around a fly camera. ?seed=&type=&x=&z=&time=&rd=
import { loadBundle, loadPng, GEN } from './assets/bundle';
import { Biomes } from './world/biomes';
import { WorldRenderer } from './render/worldrenderer';
import { WorldClient } from './world/client';
import type { StaticData } from './worker/protocol';

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
  const biomes = new Biomes(b.worldgen, b.grassColormap, b.foliageColormap, b.dryFoliageColormap);
  const wr = new WorldRenderer(gl, b, await loadPng('textures/environment/clouds.png'), biomes);
  const spriteNames = [...b.models.sprites, 'block/water_still', 'block/water_flow', 'block/water_overlay', 'block/lava_still', 'block/lava_flow'];
  const data: StaticData = {
    blocks: b.blocks, models: b.models, worldgen: b.worldgen, tags: b.tags,
    grass: b.grassColormap, foliage: b.foliageColormap, dryFoliage: b.dryFoliageColormap,
    spriteSlots: wr.textures.slotTable(spriteNames), spriteNames, structureBase: GEN + 'data/structure/',
  };
  const q = new URLSearchParams(location.search);
  const client = new WorldClient(wr.terrain);
  client.onError = fatal;
  const rd = +(q.get('rd') ?? 8);
  await client.init(data, { seed: q.get('seed') ?? '12345', type: (q.get('type') as any) ?? 'normal', structures: true, bonusChest: false }, 'phase3-' + (q.get('seed') ?? '12345'), true, 2);
  const sp = client.spawn!;
  const cam = { x: +(q.get('x') ?? sp[0]), y: +(q.get('y') ?? sp[1] + 20), z: +(q.get('z') ?? sp[2]), yaw: +(q.get('yaw') ?? 0), pitch: +(q.get('pitch') ?? 20), fov: 70 };
  let gameTime = +(q.get('time') ?? 6000);
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => keys.add(e.code));
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  canvas.addEventListener('click', () => canvas.requestPointerLock());
  window.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    cam.yaw += e.movementX * 0.15; cam.pitch = Math.max(-90, Math.min(90, cam.pitch + e.movementY * 0.15));
  });
  const resize = () => { canvas.width = Math.floor(innerWidth * devicePixelRatio); canvas.height = Math.floor(innerHeight * devicePixelRatio); };
  window.addEventListener('resize', resize); resize();
  (window as any).__mc = { cam, client, frames: 0 };
  let last = performance.now(), acc = 0, lastView = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.25, (now - last) / 1000); last = now;
    acc += dt * 20;
    while (acc >= 1) { acc--; if (q.get('freeze') === null) gameTime++; wr.tick(); }
    const s = (keys.has('ControlLeft') ? 40 : 12) * dt, yr = (cam.yaw * Math.PI) / 180;
    const fx = -Math.sin(yr), fz = Math.cos(yr);
    if (keys.has('KeyW')) { cam.x += fx * s; cam.z += fz * s; }
    if (keys.has('KeyS')) { cam.x -= fx * s; cam.z -= fz * s; }
    if (keys.has('KeyA')) { cam.x += fz * s; cam.z -= fx * s; }
    if (keys.has('KeyD')) { cam.x -= fz * s; cam.z += fx * s; }
    if (keys.has('Space')) cam.y += s;
    if (keys.has('ShiftLeft')) cam.y -= s;
    if (now - lastView > 250) { client.setView(cam.x, cam.y, cam.z, rd); lastView = now; }
    const biome = client.world.biome(Math.floor(cam.x), Math.floor(cam.y), Math.floor(cam.z));
    wr.render(cam, gameTime, acc, biome, { renderDistance: rd, gamma: 0.5, clouds: (q.get('clouds') as any) ?? 'fancy' }, canvas.width, canvas.height);
    (window as any).__mc.frames++;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
main().catch(fatal);
