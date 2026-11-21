// Minecraft (client) equivalent: boot + LoadingOverlay, screen management, input, game lifecycle.
import { loadBundle, loadJson, loadPng, type Bundle } from './assets/bundle';
import type { AtlasJson, FontJson } from './assets/types';
import { GuiRenderer } from './gui/renderer';
import { setLang, tr } from './gui/i18n';
import { Panorama, Blur, Target } from './gui/panorama';
import { Screen, TitleScreen, LoadingScreen, PauseScreen, DeathScreen, type AppApi, type Options, type CreateOptions } from './gui/screens';
import { drawTooltip, type UiCtx } from './gui/widgets';
import { Hud } from './gui/hud';
import { Game } from './game/game';
import { WorldList, WorldStore, type WorldMeta } from './save/store';
import { parseSeed } from './worldgen/random';
import { SoundManager } from './audio/sounds';
import { InventoryScreen, CreativeScreen, CraftingTableScreen, ChestScreen, FurnaceScreen, Recipes } from './gui/inventory';

const OPTIONS_KEY = 'mc26.3-options';
const DEFAULT_OPTIONS: Options = {
  renderDistance: 12, simulationDistance: 12, fov: 70, gamma: 0.5, guiScale: 0, particles: 'all', clouds: 'fancy', viewBobbing: true,
  smoothLighting: true, biomeBlend: 2, maxFps: 260, vsync: true, mouseSensitivity: 0.5, invertY: false, menuBlur: 5, shadows: false,
  volume: { master: 1, music: 1, record: 1, weather: 1, block: 1, hostile: 1, neutral: 1, player: 1, ambient: 1, voice: 1, ui: 1 },
  keys: { forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space', sneak: 'ShiftLeft', sprint: 'ControlLeft', inventory: 'KeyE', drop: 'KeyQ', chat: 'KeyT', debug: 'F3', hideGui: 'F1', screenshot: 'F2' },
};

function loadOptions(): Options {
  try {
    const s = localStorage.getItem(OPTIONS_KEY);
    if (s) { const o = JSON.parse(s); return { ...DEFAULT_OPTIONS, ...o, volume: { ...DEFAULT_OPTIONS.volume, ...o.volume }, keys: { ...DEFAULT_OPTIONS.keys, ...o.keys } }; }
  } catch { /* storage unavailable */ }
  return structuredClone(DEFAULT_OPTIONS);
}

function fatal(e: unknown): void {
  const el = document.getElementById('fatal')!;
  el.style.display = 'block';
  el.textContent = String(e instanceof Error ? e.stack ?? e.message : e);
  console.error(e);
}

class SavingScreen extends Screen {
  build(): void {}
  renderContent(c: UiCtx): void { c.g.centered(tr('menu.savingLevel'), this.width / 2, this.height / 2 - 4, 0xffffffff); }
  closeOnEsc(): boolean { return false; }
}

class App implements AppApi {
  g!: GuiRenderer;
  options = loadOptions();
  screen: Screen | null = null;
  game: Game | null = null;
  world: WorldMeta | null = null;
  hud: Hud | null = null;
  bundle!: Bundle;
  panorama!: Panorama; blur!: Blur; worldTarget!: Target;
  sounds = new SoundManager();
  splash = '';
  worlds!: WorldList;
  private t0 = performance.now();
  private mx = 0; private my = 0; private mouseDown = -1;
  private keys = new Set<string>();
  private tooltipLines: string[] | null = null;
  private lastFrame = performance.now(); private acc = 0; private frames = 0; private fpsTime = 0;
  private loadingStart = 0;
  private resources: { cloudsTex: any; endSky: any } | null = null;
  private autosave = 0;

  constructor(readonly canvas: HTMLCanvasElement, readonly gl: WebGL2RenderingContext) {}

  time(): number { return (performance.now() - this.t0) / 1000; }
  inWorld(): boolean { return !!this.game; }
  playClick(): void { this.sounds.resume(); this.sounds.play('ui.button.click', 'ui', null, 0, 0, 0.25, 1); }

  async boot(): Promise<void> {
    this.resize();
    window.addEventListener('resize', () => this.resize());
    const [atlas, atlasImg, font] = await Promise.all([loadJson<AtlasJson>('atlas/gui.json'), loadPng('atlas/gui.png'), loadJson<FontJson>('font.json')]);
    const fontImgs = await Promise.all(font.sheets.map((s) => loadPng(s.file)));
    this.g = new GuiRenderer(this.gl, atlas, atlasImg, font, fontImgs);
    const logo = this.g.upload(await loadPng('textures/gui/title/mojangstudios.png'));
    let progress = 0, done = false;
    const overlay = () => { if (done) return; this.drawLoadingOverlay(logo, progress); requestAnimationFrame(overlay); };
    requestAnimationFrame(overlay);
    this.bundle = await loadBundle((d, t) => { progress = d / t; });
    await this.sounds.load();
    setLang(this.bundle.lang);
    const splashes = this.bundle.splashes.split('\n').map((s) => s.trim()).filter((s) => s.length);
    this.splash = splashes[Math.floor(Math.random() * splashes.length)];
    const panoImgs = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => loadPng(`textures/gui/title/background/panorama_${i}.png`)));
    this.panorama = new Panorama(this.gl, panoImgs);
    this.blur = new Blur(this.gl);
    this.worldTarget = new Target(this.gl);
    this.resources = { cloudsTex: await loadPng('textures/environment/clouds.png'), endSky: await loadPng('textures/environment/end_sky.png') };
    await this.g.preload(['gui/title/minecraft.png', 'gui/title/edition.png', 'gui/menu_background.png', 'gui/inworld_menu_background.png', 'gui/menu_list_background.png',
      'gui/header_separator.png', 'gui/footer_separator.png', 'gui/title/background/panorama_overlay.png', 'misc/unknown_server.png', 'gui/tab_header_background.png',
      'gui/container/inventory.png', 'gui/container/creative_inventory/tab_items.png', 'gui/container/creative_inventory/tab_item_search.png', 'gui/container/creative_inventory/tab_inventory.png']);
    this.worlds = await WorldList.open();
    done = true;
    this.sounds.setVolumes(this.options.volume);
    this.setScreen(new TitleScreen(this));
    this.bindInput();
    (window as any).__mc = { app: this };
    requestAnimationFrame((t) => this.frame(t));
  }

  /** LoadingOverlay: Mojang red background, the two logo halves, progress bar at 83.25% height. */
  private drawLoadingOverlay(logo: { tex: WebGLTexture; w: number; h: number }, progress: number): void {
    const g = this.g, gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    g.begin(this.canvas.width, this.canvas.height, this.options.guiScale);
    gl.clearColor(0xef / 255, 0x32 / 255, 0x3d / 255, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const w = g.width, h = g.height;
    const k = w * 0.5, l = h * 0.5;
    const d = Math.min(w * 0.75, h) * 0.25, m = d * 0.5, e = d * 4, n = e * 0.5;
    g.blitL(logo, k - n, l - m, n, d, -0.0625, 0, 120, 60, 120, 120);
    g.blitL(logo, k, l - m, n, d, 0.0625, 60, 120, 60, 120, 120);
    const s = h * 0.8325, q = Math.min(w * 0.75, h) * 0.5;
    const x0 = k - q, x1 = k + q, y0 = s - 5, y1 = s + 5;
    g.fill(x0 + 2, y0 + 2, x0 + 2 + Math.ceil((x1 - x0 - 4) * progress), y1 - 2, 0xffffffff);
    g.fill(x0 + 1, y0, x1 - 1, y0 + 1, 0xffffffff); g.fill(x0 + 1, y1 - 1, x1 - 1, y1, 0xffffffff);
    g.fill(x0, y0, x0 + 1, y1, 0xffffffff); g.fill(x1 - 1, y0, x1, y1, 0xffffffff);
    g.flush();
  }

  resize(): void {
    this.canvas.width = Math.max(1, Math.floor(innerWidth * devicePixelRatio));
    this.canvas.height = Math.max(1, Math.floor(innerHeight * devicePixelRatio));
    if (this.g && this.screen) { this.g.begin(this.canvas.width, this.canvas.height, this.options.guiScale); this.screen.init(this.g.width, this.g.height); }
  }

  setScreen(s: Screen | null): void {
    this.screen = s;
    if (s) {
      this.g.begin(this.canvas.width, this.canvas.height, this.options.guiScale);
      s.init(this.g.width, this.g.height);
      if (document.pointerLockElement) document.exitPointerLock();
      if (this.game) { this.game.attackHeld = false; this.game.useHeld = false; }
    } else if (this.game) this.canvas.requestPointerLock?.();
    if (this.game) this.game.paused = !!s && s.isPauseScreen();
  }

  quit(): void { window.close(); }
  listWorlds(): Promise<WorldMeta[]> { return this.worlds.list(); }
  async deleteWorld(w: WorldMeta): Promise<void> { await this.worlds.delete(w.id); }
  async duplicateWorld(w: WorldMeta): Promise<void> {
    const list = await this.worlds.list();
    let name = w.name + ' - Copy', n = 1;
    while (list.some((x) => x.name === name)) name = `${w.name} - Copy (${++n})`;
    await this.worlds.duplicate(w, crypto.randomUUID(), name, name);
  }
  saveOptions(): void { try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(this.options)); } catch { /* private mode */ } }
  applyOptions(): void {
    this.sounds.setVolumes(this.options.volume);
    if (this.game) {
      const s = this.game.settings, o = this.options;
      const meshChange = s.smoothLighting !== o.smoothLighting || s.biomeBlend !== o.biomeBlend;
      Object.assign(s, { renderDistance: o.renderDistance, fov: o.fov, gamma: o.gamma, clouds: o.clouds, viewBobbing: o.viewBobbing, smoothLighting: o.smoothLighting, biomeBlend: o.biomeBlend, mouseSensitivity: o.mouseSensitivity, invertY: o.invertY });
      if (meshChange) this.game.client.post({ type: 'options', smoothLighting: o.smoothLighting, biomeBlend: o.biomeBlend });
    }
    if (this.screen) { this.g.begin(this.canvas.width, this.canvas.height, this.options.guiScale); this.screen.width = this.g.width; this.screen.height = this.g.height; }
  }

  async createWorld(o: CreateOptions): Promise<void> {
    const list = await this.worlds.list();
    const base = o.name.trim().replace(/[\\/:*?"<>|.]/g, '_') || 'World';
    let folder = base, n = 1;
    while (list.some((w) => w.folder === folder)) folder = `${base} (${n++})`;
    const meta: WorldMeta = {
      id: crypto.randomUUID(), name: o.name.trim(), folder, seed: parseSeed(o.seed).toString(), type: o.type, singleBiome: o.singleBiome,
      gameMode: o.gameMode === 'hardcore' ? 'survival' : o.gameMode, difficulty: o.gameMode === 'hardcore' ? 'hard' : o.difficulty,
      hardcore: o.gameMode === 'hardcore', cheats: o.cheats, structures: o.structures, bonusChest: o.bonusChest,
      created: Date.now(), lastPlayed: Date.now(), version: '26.3',
      gameRules: { doDaylightCycle: true, keepInventory: false, naturalRegeneration: true, doMobSpawning: true, doTileDrops: true, fallDamage: true },
    };
    await this.worlds.put(meta);
    await this.playWorld(meta);
  }

  async playWorld(w: WorldMeta): Promise<void> {
    this.sounds.stopMusic();
    this.world = w;
    w.lastPlayed = Date.now();
    await this.worlds.put(w);
    const o = this.options;
    const game = new Game(this.gl, this.bundle, { renderDistance: o.renderDistance, fov: o.fov, gamma: o.gamma, clouds: o.clouds, viewBobbing: o.viewBobbing, smoothLighting: o.smoothLighting, biomeBlend: o.biomeBlend, mouseSensitivity: o.mouseSensitivity, invertY: o.invertY },
      this.resources!.cloudsTex, this.resources!.endSky);
    this.game = game;
    game.hardcore = w.hardcore;
    game.gameRules = { ...game.gameRules, ...w.gameRules };
    game.onSound = (name, x, y, z, vol = 1, pitch = 1) => {
      if (name.startsWith('#block:')) { const [, block, kind] = name.split(':'); this.sounds.block(block, kind, x, y, z, vol, pitch); }
      else this.sounds.play(name, name.startsWith('block') ? 'block' : 'player', x, y, z, vol, pitch);
    };
    game.recipes = new Recipes(game);
    game.onOpenScreen = (kind, data) => {
      if (kind === 'crafting') this.setScreen(new CraftingTableScreen(this, game));
      else if (kind === 'chest') this.setScreen(new ChestScreen(this, game, data.items, 3, tr('container.chest')));
      else if (kind === 'furnace') this.setScreen(new FurnaceScreen(this, game, data, tr('container.furnace')));
    };
    game.onDeath = (msg) => this.setScreen(new DeathScreen(this, tr(msg, 'Player'), w.hardcore, game.player.xpTotal));
    this.hud = new Hud(this.g, game);
    this.setScreen(new LoadingScreen(this));
    game.client.onError = fatal;
    await game.start({ seed: w.seed, type: w.type as any, singleBiome: w.singleBiome, structures: w.structures, bonusChest: w.bonusChest }, w.id, w.gameMode as any, w.difficulty);
    const store = await WorldStore.open(w.id);
    const pd = await store.getMeta('player') as any;
    const ld = await store.getMeta('level') as any;
    if (pd) {
      const p = game.player;
      p.setPos(pd.x, pd.y, pd.z); p.yaw = pd.yaw; p.pitch = pd.pitch; p.health = pd.health; p.food = pd.food; p.saturation = pd.saturation;
      p.xpLevel = pd.xpLevel; p.xpProgress = pd.xpProgress; p.xpTotal = pd.xpTotal; p.gameMode = pd.gameMode ?? p.gameMode; p.air = pd.air ?? 300;
      (pd.inventory as any[]).forEach((s, i) => { p.inventory.slots[i] = s; });
      p.inventory.selected = pd.selected ?? 0; p.flying = !!pd.flying;
      p.xo = p.x; p.yo = p.y; p.zo = p.z;
    } else if (w.bonusChest) game.pendingBonusChest = true;
    if (ld) { game.dayTime = ld.dayTime; game.gameTime = ld.gameTime; }
    const cd = await store.getMeta('containers') as any;
    if (cd) for (const [k, v] of Object.entries(cd)) game.containers.set(k, v as any);
    this.loadingStart = performance.now();
  }

  private async persist(): Promise<void> {
    const game = this.game, w = this.world; if (!game || !w) return;
    const p = game.player;
    const store = await WorldStore.open(w.id);
    await store.putMeta('player', { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, health: p.health, food: p.food, saturation: p.saturation, xpLevel: p.xpLevel, xpProgress: p.xpProgress, xpTotal: p.xpTotal, gameMode: p.gameMode, air: p.air, inventory: p.inventory.slots, selected: p.inventory.selected, flying: p.flying });
    await store.putMeta('level', { dayTime: game.dayTime, gameTime: game.gameTime });
    await store.putMeta('containers', Object.fromEntries(game.containers));
    await game.client.save();
    w.lastPlayed = Date.now(); await this.worlds.put(w);
  }

  resumeGame(): void { this.setScreen(null); }
  async saveAndQuit(): Promise<void> {
    const g = this.game;
    if (g) {
      this.setScreen(new SavingScreen(this));
      if (this.world?.hardcore && g.player.dead) await this.worlds.delete(this.world.id); else await this.persist();
      g.client.terminate();
    }
    this.game = null; this.hud = null; this.world = null;
    this.setScreen(new TitleScreen(this));
  }
  respawn(): void {
    const g = this.game; if (!g) return;
    if (this.world?.hardcore) { g.player.gameMode = 'spectator'; g.player.dead = false; g.player.health = 20; this.setScreen(null); return; }
    const sp = g.client.spawn!;
    if (!g.gameRules.keepInventory) {
      for (let i = 0; i < g.player.inventory.slots.length; i++) {
        const s = g.player.inventory.slots[i];
        if (s) g.spawnItem(g.player.x, g.player.y + 1, g.player.z, s);
        g.player.inventory.slots[i] = null;
      }
    }
    g.player.respawn(sp[0], sp[1], sp[2]);
    this.setScreen(null);
  }
  loadingProgress() {
    const g = this.game;
    const total = 9;
    return { loaded: g ? Math.min(total, g.client.loaded) : 0, total, grid: null };
  }

  // ------------------------------------------------------------------ input
  private ui(): UiCtx {
    return { g: this.g, mx: this.mx, my: this.my, time: this.time(), playClick: () => this.playClick(), tooltip: (l) => { this.tooltipLines = l; } };
  }
  private bindInput(): void {
    const c = this.canvas;
    const toGui = (e: MouseEvent) => { this.mx = (e.clientX * devicePixelRatio) / this.g.scale; this.my = (e.clientY * devicePixelRatio) / this.g.scale; };
    window.addEventListener('mousemove', (e) => {
      toGui(e);
      if (this.screen) { if (this.mouseDown >= 0) this.screen.mouseDrag(this.ui()); return; }
      const g = this.game;
      if (g && document.pointerLockElement === c && !g.player.dead) {
        // MouseHandler.turnPlayer: (s*0.6+0.2)^3 * 8, 0.15 degrees per unit
        const s = this.options.mouseSensitivity * 0.6 + 0.2, f = s * s * s * 8;
        g.player.yaw += e.movementX * f * 0.15;
        g.player.pitch = Math.max(-90, Math.min(90, g.player.pitch + e.movementY * f * 0.15 * (this.options.invertY ? -1 : 1)));
      }
    });
    window.addEventListener('mousedown', (e) => {
      this.sounds.resume();
      toGui(e);
      if (this.screen) { this.mouseDown = e.button; this.screen.mouseDown(this.ui(), e.button); return; }
      const g = this.game; if (!g) return;
      if (document.pointerLockElement !== c) { c.requestPointerLock(); return; }
      if (e.button === 0) g.attackHeld = true;
      if (e.button === 2) { g.useHeld = true; g.useDelay = 0; }
      if (e.button === 1) g.pickBlock();
    });
    window.addEventListener('mouseup', (e) => {
      toGui(e);
      if (this.screen) { this.mouseDown = -1; this.screen.mouseUp(this.ui(), e.button); return; }
      const g = this.game; if (!g) return;
      if (e.button === 0) g.attackHeld = false;
      if (e.button === 2) g.useHeld = false;
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('wheel', (e) => {
      if (this.screen) { this.screen.scroll(this.ui(), Math.sign(e.deltaY)); return; }
      const g = this.game; if (g && !g.player.dead) g.selectSlot(g.player.inventory.selected + Math.sign(e.deltaY));
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && this.game && !this.screen && !this.game.player.dead) this.setScreen(new PauseScreen(this));
    });
    window.addEventListener('keydown', (e) => {
      if (['F1', 'F2', 'F3', 'Tab', 'Space'].includes(e.code)) e.preventDefault();
      this.sounds.resume();
      if (this.screen) {
        if (this.screen.key(e)) return;
        if (e.key.length === 1 && this.screen.char(e.key)) return;
        if (e.code === this.options.keys.inventory && (this.screen instanceof InventoryScreen || this.screen instanceof CreativeScreen || this.screen instanceof ChestScreen || this.screen instanceof CraftingTableScreen || this.screen instanceof FurnaceScreen) && !this.screen.typing()) this.screen.onClose();
        return;
      }
      const g = this.game; if (!g) return;
      this.keys.add(e.code);
      const k = this.options.keys;
      if (e.code === 'Escape') this.setScreen(new PauseScreen(this));
      else if (e.code === k.debug) this.hud!.debug = !this.hud!.debug;
      else if (e.code === k.hideGui) this.hud!.hidden = !this.hud!.hidden;
      else if (e.code === k.inventory) this.setScreen(g.player.gameMode === 'creative' ? new CreativeScreen(this, g) : new InventoryScreen(this, g));
      else if (e.code === k.drop) g.dropHeld(e.ctrlKey);
      else if (/^Digit[1-9]$/.test(e.code)) g.selectSlot(+e.code.slice(5) - 1);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private updateInput(): void {
    const g = this.game; if (!g) return;
    const k = this.options.keys, d = (c: string) => this.keys.has(c) && !this.screen;
    g.input = {
      forward: (d(k.forward) ? 1 : 0) - (d(k.back) ? 1 : 0), strafe: (d(k.left) ? 1 : 0) - (d(k.right) ? 1 : 0),
      jump: d(k.jump), sneak: d(k.sneak), sprint: d(k.sprint),
    };
  }

  // ------------------------------------------------------------------ loop
  private frame(now: number): void {
    try { this.frameInner(now); } catch (e) { fatal(e); return; }
    requestAnimationFrame((t) => this.frame(t));
  }
  private frameInner(now: number): void {
    const dt = Math.min(0.25, (now - this.lastFrame) / 1000); this.lastFrame = now;
    this.frames++; if (now - this.fpsTime >= 1000) { if (this.hud) this.hud.fps = this.frames; this.frames = 0; this.fpsTime = now; }
    this.acc += dt * 20;
    let ticks = 0;
    while (this.acc >= 1 && ticks < 10) {
      this.acc--; ticks++;
      this.updateInput();
      this.game?.tick();
      this.screen?.tick();
      this.sounds.tickMusic(this.game ? (this.game.player.gameMode === 'creative' ? 'creative' : 'game') : 'menu');
      if (this.game && !this.game.paused && ++this.autosave >= 6000) { this.autosave = 0; this.persist(); }
    }
    if (ticks >= 10) this.acc = 0;
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
    const game = this.game;
    if (game && this.screen instanceof LoadingScreen && game.spawnReady() && performance.now() - this.loadingStart > 500) this.setScreen(null);
    if (game) {
      const p = game.player;
      this.sounds.listener = { x: p.x, y: p.y + p.eyeHeight, z: p.z, yaw: p.yaw };
      if (this.screen instanceof LoadingScreen) {
        this.panorama.advance(dt * 20); this.panorama.renderTo(W, H); this.blur.apply(this.panorama.target, this.options.menuBlur, W, H);
      } else if (this.screen && this.screen.transparentInWorld && !(this.screen instanceof DeathScreen) && this.options.menuBlur > 0) {
        this.worldTarget.resize(W, H); this.worldTarget.bind();
        game.render(this.acc, W, H);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.blur.apply(this.worldTarget, this.options.menuBlur, W, H);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        game.render(this.acc, W, H);
      }
      if (!(this.screen instanceof LoadingScreen)) {
        this.g.begin(W, H, this.options.guiScale);
        this.hud!.render();
        this.g.flush();
      }
    } else {
      this.panorama.advance(dt * 20);
      this.panorama.renderTo(W, H);
      this.blur.apply(this.panorama.target, this.options.menuBlur, W, H);
    }
    if (this.screen) {
      this.g.begin(W, H, this.options.guiScale);
      this.tooltipLines = null;
      const ctx = this.ui();
      this.screen.render(ctx, this.acc);
      this.screen.renderTooltips(ctx, dt);
      this.g.flush();
      if (this.tooltipLines) { drawTooltip(this.g, this.tooltipLines, this.mx, this.my); this.g.flush(); }
    }
  }
}

async function main(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 is required');
  await new App(canvas, gl).boot();
}
main().catch(fatal);
