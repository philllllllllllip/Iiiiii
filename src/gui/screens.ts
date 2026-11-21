// Screens: layouts follow the vanilla Screen classes (TitleScreen, SelectWorldScreen, CreateWorldScreen,
// LevelLoadingScreen, PauseScreen, OptionsScreen, VideoSettingsScreen, SoundOptionsScreen, DeathScreen,
// ConfirmScreen). Coordinates are GUI pixels.
import type { GuiRenderer } from './renderer';
import { Widget, Button, CycleButton, Slider, EditBox, drawTooltip, type UiCtx } from './widgets';
import { tr } from './i18n';
import type { WorldMeta } from '../save/store';

export interface AppApi {
  g: GuiRenderer;
  setScreen(s: Screen | null): void;
  quit(): void;
  listWorlds(): Promise<WorldMeta[]>;
  createWorld(opts: CreateOptions): void;
  playWorld(w: WorldMeta): void;
  deleteWorld(w: WorldMeta): Promise<void>;
  duplicateWorld(w: WorldMeta): Promise<void>;
  options: Options;
  saveOptions(): void;
  applyOptions(): void;
  inWorld(): boolean;
  resumeGame(): void;
  saveAndQuit(): void;
  respawn(): void;
  splash: string;
  loadingProgress(): { loaded: number; total: number; grid: Uint8Array | null };
  time(): number;
  playClick(): void;
}

export interface Options {
  renderDistance: number; simulationDistance: number; fov: number; gamma: number; guiScale: number; particles: 'all' | 'decreased' | 'minimal';
  clouds: 'off' | 'fast' | 'fancy'; viewBobbing: boolean; smoothLighting: boolean; biomeBlend: number; maxFps: number; vsync: boolean;
  mouseSensitivity: number; invertY: boolean; menuBlur: number; shadows: boolean;
  volume: Record<string, number>;
  keys: Record<string, string>;
}

export interface CreateOptions {
  name: string; seed: string; gameMode: 'survival' | 'creative' | 'hardcore'; difficulty: 'peaceful' | 'easy' | 'normal' | 'hard';
  cheats: boolean; type: 'normal' | 'flat' | 'large_biomes' | 'amplified' | 'single_biome'; structures: boolean; bonusChest: boolean;
  singleBiome?: string;
}

export abstract class Screen {
  widgets: Widget[] = [];
  width = 0; height = 0;
  title = '';
  transparentInWorld = true;
  constructor(readonly app: AppApi) {}
  init(w: number, h: number): void { this.width = w; this.height = h; this.widgets = []; this.build(); }
  abstract build(): void;
  add<T extends Widget>(w: T): T { this.widgets.push(w); return w; }
  /** background: panorama/blur handled by the app; this draws the menu background overlay */
  renderBackground(c: UiCtx): void {
    if (this.app.inWorld()) {
      const t = c.g.texture('gui/inworld_menu_background.png');
      if (t) c.g.blitL(t, 0, 0, this.width, this.height, 0, 0, this.width, this.height, 32, 32);
    } else {
      const t = c.g.texture('gui/menu_background.png');
      if (t) c.g.blitL(t, 0, 0, this.width, this.height, 0, 0, this.width, this.height, 32, 32);
    }
  }
  render(c: UiCtx, _partial: number): void {
    this.renderBackground(c);
    this.renderContent(c);
    for (const w of this.widgets) if (w.visible) w.render(c);
  }
  renderContent(_c: UiCtx): void {}
  tick(): void { for (const w of this.widgets) w.tick(); }
  mouseDown(c: UiCtx, b: number): boolean {
    for (const w of this.widgets) w.focused = false;
    for (const w of [...this.widgets].reverse()) if (w.visible && w.mouseDown(c, b)) { w.focused = w instanceof EditBox ? w.focused : false; return true; }
    return false;
  }
  mouseUp(c: UiCtx, b: number): void { for (const w of this.widgets) w.mouseUp(c, b); }
  mouseDrag(c: UiCtx): void { for (const w of this.widgets) w.mouseDrag(c); }
  scroll(_c: UiCtx, _d: number): void {}
  key(e: KeyboardEvent): boolean {
    for (const w of this.widgets) if (w.key(e)) return true;
    if (e.code === 'Escape' && this.closeOnEsc()) { this.onClose(); return true; }
    if (e.code === 'Tab') { this.cycleFocus(e.shiftKey ? -1 : 1); return true; }
    return false;
  }
  char(ch: string): boolean { for (const w of this.widgets) if (w.char(ch)) return true; return false; }
  cycleFocus(d: number): void {
    const f = this.widgets.filter((w) => w.visible && w.active);
    if (!f.length) return;
    const i = f.findIndex((w) => w.focused);
    for (const w of f) w.focused = false;
    f[(i + d + f.length) % f.length].focused = true;
  }
  closeOnEsc(): boolean { return true; }
  onClose(): void { this.app.setScreen(null); }
  renderTooltips(c: UiCtx, dt: number): void { for (const w of this.widgets) w.renderTooltip(c, dt); }
  isPauseScreen(): boolean { return true; }
}

// ---------------------------------------------------------------------------------------------
export class TitleScreen extends Screen {
  transparentInWorld = false;
  build(): void {
    const l = this.height / 4 + 48;
    const cx = this.width / 2;
    this.add(new Button(cx - 100, l, 200, 20, tr('menu.singleplayer'), () => this.app.setScreen(new SelectWorldScreen(this.app, this))));
    const mp = this.add(new Button(cx - 100, l + 24, 200, 20, tr('menu.multiplayer'), () => {}));
    mp.active = false; mp.tooltipLines = [tr('title.multiplayer.disabled')];
    const rl = this.add(new Button(cx - 100, l + 48, 200, 20, tr('menu.online'), () => {}));
    rl.active = false; rl.tooltipLines = [tr('title.multiplayer.disabled')];
    this.add(new Button(cx - 100, l + 72 + 12, 98, 20, tr('menu.options'), () => this.app.setScreen(new OptionsScreen(this.app, this))));
    this.add(new Button(cx + 2, l + 72 + 12, 98, 20, tr('menu.quit'), () => this.app.quit()));
  }
  closeOnEsc(): boolean { return false; }
  renderBackground(c: UiCtx): void {
    const t = c.g.texture('gui/title/background/panorama_overlay.png');
    if (t) c.g.blitL(t, 0, 0, this.width, this.height, 0, 0, 1, 1, 1, 1);
  }
  renderContent(c: UiCtx): void {
    const g = c.g;
    // LogoRenderer: minecraft.png 256x44 at (w/2 - 128, 30), edition.png 128x14 just below overlapping by 7
    const logo = g.texture('gui/title/minecraft.png'), ed = g.texture('gui/title/edition.png');
    if (logo) g.blitL(logo, this.width / 2 - 128, 30, 256, 44, 0, 0, 256, 44, 256, 64);
    if (ed) g.blitL(ed, this.width / 2 - 64, 30 + 37, 128, 14, 0, 0, 128, 14, 128, 16);
    // SplashRenderer: rotate -20 deg at (w/2 + 123, 69), scale 1.8 - |sin(t)| * 0.1, fit to 100px
    const s = this.app.splash;
    if (s) {
      const ms = this.app.time() * 1000;
      let sc = 1.8 - Math.abs(Math.sin(((ms % 1000) / 1000) * Math.PI * 2) * 0.1);
      sc = (sc * 100) / (g.textWidth(s) + 32);
      g.flush();
      this.drawTransformedText(c, s, this.width / 2 + 123, 69, -20, sc, 0xffffff00);
    }
    g.text('Minecraft 26.3', 2, this.height - 10, 0xffffffff);
    const cr = tr('title.credits');
    g.text(cr, this.width - g.textWidth(cr) - 2, this.height - 10, 0xffffffff);
  }
  /** Splash: rotated, scaled text centred on the anchor (GuiGraphics pose stack). */
  private drawTransformedText(c: UiCtx, s: string, ax: number, ay: number, deg: number, sc: number, color: number): void {
    (c.g as any).transformed(ax, ay, deg, sc, () => c.g.centered(s, 0, -8, color));
  }
  isPauseScreen(): boolean { return false; }
}

// ---------------------------------------------------------------------------------------------
export class SelectWorldScreen extends Screen {
  worlds: WorldMeta[] | null = null; selected = -1; scrollY = 0; search: EditBox | null = null;
  private lastClick = 0;
  constructor(app: AppApi, readonly parent: Screen) { super(app); this.title = tr('selectWorld.title'); this.load(); }
  async load(): Promise<void> { this.worlds = await this.app.listWorlds(); this.selected = this.worlds.length ? 0 : -1; this.updateButtons(); }
  private play!: Button; private edit!: Button; private del!: Button; private recreate!: Button;
  build(): void {
    const cx = this.width / 2;
    this.search = this.add(new EditBox(cx - 100, 22, 200, 20)); this.search.hint = tr('selectWorld.search');
    const by = this.height - 52;
    this.play = this.add(new Button(cx - 154, by, 150, 20, tr('selectWorld.select'), () => this.playSel()));
    this.add(new Button(cx + 4, by, 150, 20, tr('selectWorld.create'), () => this.app.setScreen(new CreateWorldScreen(this.app, this))));
    this.edit = this.add(new Button(cx - 154, by + 24, 72, 20, tr('selectWorld.edit'), () => { const w = this.sel(); if (w) this.app.duplicateWorld(w).then(() => this.load()); }));
    this.edit.tooltipLines = [tr('selectWorld.edit.title')];
    this.del = this.add(new Button(cx - 76, by + 24, 72, 20, tr('selectWorld.delete'), () => {
      const w = this.sel(); if (!w) return;
      this.app.setScreen(new ConfirmScreen(this.app, tr('selectWorld.deleteQuestion'), tr('selectWorld.deleteWarning', w.name), tr('selectWorld.deleteButton'), tr('gui.cancel'), async (ok) => {
        if (ok) await this.app.deleteWorld(w);
        await this.load();
        this.app.setScreen(this);
      }));
    }));
    this.recreate = this.add(new Button(cx + 4, by + 24, 72, 20, tr('selectWorld.recreate'), () => {
      const w = this.sel(); if (!w) return;
      const s = new CreateWorldScreen(this.app, this);
      s.prefill({ name: w.name, seed: w.seed, gameMode: w.hardcore ? 'hardcore' : w.gameMode === 'creative' ? 'creative' : 'survival', difficulty: w.difficulty, cheats: w.cheats, type: w.type as any, structures: w.structures, bonusChest: w.bonusChest });
      this.app.setScreen(s);
    }));
    this.add(new Button(cx + 82, by + 24, 72, 20, tr('gui.back'), () => this.app.setScreen(this.parent)));
    this.updateButtons();
  }
  private filtered(): WorldMeta[] { const q = (this.search?.value ?? '').toLowerCase(); return (this.worlds ?? []).filter((w) => !q || w.name.toLowerCase().includes(q) || w.folder.toLowerCase().includes(q)); }
  private sel(): WorldMeta | null { return this.filtered()[this.selected] ?? null; }
  private playSel(): void { const w = this.sel(); if (w) this.app.playWorld(w); }
  updateButtons(): void { if (!this.play) return; const has = !!this.sel(); this.play.active = this.edit.active = this.del.active = this.recreate.active = has; }
  private listTop = 48; private get listBottom() { return this.height - 64; }
  renderContent(c: UiCtx): void {
    const g = c.g;
    g.centered(this.title, this.width / 2, 8, 0xffffffff);
    // list background + separators (AbstractSelectionList)
    const lb = g.texture('gui/menu_list_background.png');
    if (lb) g.blitL(lb, 0, this.listTop, this.width, this.listBottom - this.listTop, 0, this.listTop, this.width, this.listBottom - this.listTop, 32, 32);
    const hs = g.texture('gui/header_separator.png'), fs = g.texture('gui/footer_separator.png');
    if (hs) g.blitL(hs, 0, this.listTop - 2, this.width, 2, 0, 0, this.width, 2, 32, 2);
    if (fs) g.blitL(fs, 0, this.listBottom, this.width, 2, 0, 0, this.width, 2, 32, 2);
    if (!this.worlds) { g.centered(tr('selectWorld.loading_list'), this.width / 2, (this.listTop + this.listBottom) / 2 - 4, 0xffffffff); return; }
    const rowW = 270, x0 = this.width / 2 - rowW / 2, itemH = 36;
    const list = this.filtered();
    list.forEach((w, i) => {
      const y = this.listTop + 4 + i * itemH - this.scrollY;
      if (y + itemH < this.listTop || y > this.listBottom) return;
      if (i === this.selected) { g.fill(x0 - 2, y - 2, x0 + rowW - 2, y + itemH - 2, 0xff808080); g.fill(x0 - 1, y - 1, x0 + rowW - 3, y + itemH - 3, 0xff000000); }
      const icon = g.texture('misc/unknown_server.png');
      if (icon) g.blitL(icon, x0, y, 32, 32, 0, 0, 32, 32, 32, 32);
      g.text(w.name, x0 + 32 + 3, y + 1, 0xffffffff);
      const date = new Date(w.lastPlayed);
      const ds = `${date.getMonth() + 1}/${date.getDate()}/${String(date.getFullYear()).slice(2)}, ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      g.text(`${w.folder} (${ds})`, x0 + 32 + 3, y + 12, 0xff808080);
      const mode = w.hardcore ? tr('gameMode.hardcore') : tr('gameMode.' + w.gameMode);
      g.text(mode + (w.cheats ? ', ' + tr('selectWorld.cheats') : '') + ', ' + tr('selectWorld.version') + ' 26.3', x0 + 32 + 3, y + 12 + 10, 0xff808080);
      if (i === this.selected || (c.mx >= x0 && c.mx < x0 + 32 && c.my >= y && c.my < y + 32)) {
        const hov = c.mx >= x0 && c.mx < x0 + 32 && c.my >= y && c.my < y + 32;
        g.fill(x0, y, x0 + 32, y + 32, 0xa0909090);
        g.sprite(hov ? 'world_list/join_highlighted' : 'world_list/join', x0, y, 32, 32);
      }
    });
  }
  mouseDown(c: UiCtx, b: number): boolean {
    if (super.mouseDown(c, b)) return true;
    if (c.my >= this.listTop && c.my < this.listBottom && this.worlds) {
      const i = Math.floor((c.my - this.listTop - 4 + this.scrollY) / 36);
      const list = this.filtered();
      if (i >= 0 && i < list.length && Math.abs(c.mx - this.width / 2) < 135) {
        const x0 = this.width / 2 - 135;
        const now = performance.now();
        if ((i === this.selected && now - this.lastClick < 250) || c.mx < x0 + 32) { this.selected = i; this.playSel(); }
        this.selected = i; this.lastClick = now; this.updateButtons();
        c.playClick();
        return true;
      }
    }
    return false;
  }
  scroll(_c: UiCtx, d: number): void {
    const max = Math.max(0, this.filtered().length * 36 + 8 - (this.listBottom - this.listTop));
    this.scrollY = Math.max(0, Math.min(max, this.scrollY + d * 18));
  }
  key(e: KeyboardEvent): boolean {
    if (super.key(e)) { this.updateButtons(); return true; }
    if (e.code === 'Enter') { this.playSel(); return true; }
    return false;
  }
  char(ch: string): boolean { const r = super.char(ch); this.selected = 0; this.updateButtons(); return r; }
  onClose(): void { this.app.setScreen(this.parent); }
}

// ---------------------------------------------------------------------------------------------
export class CreateWorldScreen extends Screen {
  tab = 0;
  opts: CreateOptions = { name: tr('selectWorld.newWorld'), seed: '', gameMode: 'survival', difficulty: 'normal', cheats: false, type: 'normal', structures: true, bonusChest: false };
  private createBtn!: Button;
  constructor(app: AppApi, readonly parent: Screen) { super(app); this.title = tr('selectWorld.create'); }
  prefill(o: CreateOptions): void { this.opts = { ...o }; }
  build(): void {
    const cx = this.width / 2;
    // TabNavigationBar: three tabs, each 130 wide, centred in the header
    const tabs = [tr('createWorld.tab.game.title'), tr('createWorld.tab.world.title'), tr('createWorld.tab.more.title')];
    tabs.forEach((t, i) => {
      const b = this.add(new TabButton(cx - 195 + i * 130, 0, 130, 24, t, i === this.tab, () => { this.tab = i; this.init(this.width, this.height); }));
      void b;
    });
    const top = 24 + 16;
    if (this.tab === 0) {
      const name = this.add(new EditBox(cx - 104, top + 12, 208, 20));
      name.set(this.opts.name); name.onChange = (v) => { this.opts.name = v; this.updateCreate(); }; name.focused = true;
      const modes: CreateOptions['gameMode'][] = ['survival', 'hardcore', 'creative'];
      const gm = this.add(new CycleButton(cx - 105, top + 44, 210, 20, tr('selectWorld.gameMode'), modes, modes.indexOf(this.opts.gameMode),
        (v) => tr('selectWorld.gameMode.' + v), (v) => { this.opts.gameMode = v; if (v === 'hardcore') { this.opts.difficulty = 'hard'; this.opts.cheats = false; } this.init(this.width, this.height); }));
      gm.tooltipLines = [tr('selectWorld.gameMode.' + this.opts.gameMode + '.info')];
      const diffs: CreateOptions['difficulty'][] = ['peaceful', 'easy', 'normal', 'hard'];
      const df = this.add(new CycleButton(cx - 105, top + 68, 210, 20, tr('options.difficulty'), diffs, diffs.indexOf(this.opts.difficulty), (v) => tr('options.difficulty.' + v), (v) => { this.opts.difficulty = v; }));
      df.active = this.opts.gameMode !== 'hardcore';
      const ch = this.add(new CycleButton(cx - 105, top + 92, 210, 20, tr('selectWorld.allowCommands'), [false, true], this.opts.cheats ? 1 : 0, (v) => tr(v ? 'options.on' : 'options.off'), (v) => { this.opts.cheats = v; }));
      ch.active = this.opts.gameMode !== 'hardcore'; ch.tooltipLines = [tr('selectWorld.allowCommands.info')];
    } else if (this.tab === 1) {
      const types: CreateOptions['type'][] = ['normal', 'flat', 'large_biomes', 'amplified', 'single_biome'];
      const names = { normal: 'normal', flat: 'flat', large_biomes: 'large_biomes', amplified: 'amplified', single_biome: 'single_biome_surface' } as const;
      const wt = this.add(new CycleButton(cx - 155, top + 4, 150, 20, tr('selectWorld.mapType'), types, types.indexOf(this.opts.type), (v) => tr('generator.minecraft.' + names[v]), (v) => { this.opts.type = v; }));
      void wt;
      const cust = this.add(new Button(cx + 5, top + 4, 150, 20, tr('selectWorld.customizeType'), () => {}));
      cust.active = false;
      const seed = this.add(new EditBox(cx - 154, top + 48, 308, 20));
      seed.set(this.opts.seed); seed.hint = tr('selectWorld.seedInfo'); seed.onChange = (v) => { this.opts.seed = v; };
      const st = this.add(new CycleButton(cx - 155, top + 80, 150, 20, tr('selectWorld.mapFeatures'), [false, true], this.opts.structures ? 1 : 0, (v) => tr(v ? 'options.on' : 'options.off'), (v) => { this.opts.structures = v; }));
      st.tooltipLines = [tr('selectWorld.mapFeatures.info')];
      this.add(new CycleButton(cx + 5, top + 80, 150, 20, tr('selectWorld.bonusItems'), [false, true], this.opts.bonusChest ? 1 : 0, (v) => tr(v ? 'options.on' : 'options.off'), (v) => { this.opts.bonusChest = v; }));
    } else {
      for (const [i, k] of ['selectWorld.gameRules', 'selectWorld.experiments', 'selectWorld.dataPacks'].entries()) {
        const b = this.add(new Button(cx - 105, top + 8 + i * 24, 210, 20, tr(k), () => {}));
        b.active = false;
      }
    }
    this.createBtn = this.add(new Button(cx - 154, this.height - 28, 150, 20, tr('selectWorld.create'), () => this.app.createWorld(this.opts)));
    this.add(new Button(cx + 4, this.height - 28, 150, 20, tr('gui.cancel'), () => this.app.setScreen(this.parent)));
    this.updateCreate();
  }
  updateCreate(): void { if (this.createBtn) this.createBtn.active = this.opts.name.trim().length > 0; }
  renderContent(c: UiCtx): void {
    const g = c.g, cx = this.width / 2, top = 24 + 16;
    const hb = g.texture('gui/tab_header_background.png');
    if (hb) g.blitL(hb, 0, 0, this.width, 24, 0, 0, this.width, 24, 16, 16);
    const hs = g.texture('gui/header_separator.png');
    if (hs) g.blitL(hs, 0, 24 - 2, this.width, 2, 0, 0, this.width, 2, 32, 2);
    const fs = g.texture('gui/footer_separator.png');
    if (fs) g.blitL(fs, 0, this.height - 36, this.width, 2, 0, 0, this.width, 2, 32, 2);
    if (this.tab === 0) {
      g.text(tr('selectWorld.enterName'), cx - 104, top, 0xffa0a0a0);
    } else if (this.tab === 1) {
      g.text(tr('selectWorld.enterSeed'), cx - 154, top + 36, 0xffa0a0a0);
    }
  }
  onClose(): void { this.app.setScreen(this.parent); }
}

class TabButton extends Button {
  constructor(x: number, y: number, w: number, h: number, label: string, public selected: boolean, onPress: () => void) { super(x, y, w, h, label, onPress); }
  render(c: UiCtx): void {
    const hov = this.hovered(c);
    c.g.sprite('widget/tab' + (this.selected ? '_selected' : '') + (hov ? '_highlighted' : ''), this.x, this.y, this.w, this.h);
    c.g.centered(this.label, this.x + this.w / 2, this.y + (this.h - 8) / 2 + (this.selected ? 0 : 1), this.selected ? 0xffffffff : 0xffa0a0a0);
    if (this.selected) c.g.fill(this.x + 1 + 1, this.y + this.h - 3, this.x + this.w - 2, this.y + this.h - 2, 0xffffffff);
  }
}

// ---------------------------------------------------------------------------------------------
export class ConfirmScreen extends Screen {
  constructor(app: AppApi, readonly t1: string, readonly t2: string, readonly yes: string, readonly no: string, readonly cb: (ok: boolean) => void) { super(app); }
  build(): void {
    const cx = this.width / 2;
    this.add(new Button(cx - 155, this.height / 6 + 96, 150, 20, this.yes, () => this.cb(true)));
    this.add(new Button(cx + 5, this.height / 6 + 96, 150, 20, this.no, () => this.cb(false)));
  }
  renderContent(c: UiCtx): void {
    c.g.centered(this.t1, this.width / 2, 70, 0xffffffff);
    c.g.wrap(this.t2, this.width - 50).forEach((l, i) => c.g.centered(l, this.width / 2, 90 + i * 9, 0xffffffff));
  }
  onClose(): void { this.cb(false); }
}

// ---------------------------------------------------------------------------------------------
export class LoadingScreen extends Screen {
  transparentInWorld = false;
  build(): void {}
  closeOnEsc(): boolean { return false; }
  renderContent(c: UiCtx): void {
    const g = c.g;
    const p = this.app.loadingProgress();
    const pct = Math.min(100, Math.floor((p.loaded / Math.max(1, p.total)) * 100));
    // LevelLoadingScreen: percentage text above the chunk status map (status colours)
    const cx = this.width / 2, cy = this.height / 2;
    g.centered(tr('multiplayer.downloadingTerrain'), cx, cy - 30 - 30, 0xffffffff);
    g.centered(tr('loading.progress', pct), cx, cy - 30 - 9 / 2 - 6, 0xffffffff);
    if (p.grid) {
      const n = Math.sqrt(p.grid.length) | 0, s = 2;
      const x0 = cx - (n * s) / 2, y0 = cy - (n * s) / 2 + 10;
      g.fill(x0 - 1, y0 - 1, x0 + n * s + 1, y0 + n * s + 1, 0xff000000);
      const col = [0xff000000, 0xff665555, 0xff98d982, 0xff6c7b8a, 0xffffffff];
      for (let i = 0; i < p.grid.length; i++) {
        const v = p.grid[i]; if (!v) continue;
        const gx = i % n, gy = (i / n) | 0;
        g.fill(x0 + gx * s, y0 + gy * s, x0 + gx * s + s, y0 + gy * s + s, col[v]);
      }
    }
  }
  isPauseScreen(): boolean { return false; }
}

// ---------------------------------------------------------------------------------------------
export class PauseScreen extends Screen {
  constructor(app: AppApi) { super(app); this.title = tr('menu.game'); }
  build(): void {
    const cx = this.width / 2, y = this.height / 4 + 8;
    this.add(new Button(cx - 102, y, 204, 20, tr('menu.returnToGame'), () => this.app.resumeGame()));
    const adv = this.add(new Button(cx - 102, y + 24, 98, 20, tr('gui.advancements'), () => {})); adv.active = false;
    const st = this.add(new Button(cx + 4, y + 24, 98, 20, tr('gui.stats'), () => {})); st.active = false;
    const fb = this.add(new Button(cx - 102, y + 48, 98, 20, tr('menu.feedback'), () => {})); fb.active = false;
    const rb = this.add(new Button(cx + 4, y + 48, 98, 20, tr('menu.reportBugs'), () => {})); rb.active = false;
    this.add(new Button(cx - 102, y + 72, 98, 20, tr('menu.options'), () => this.app.setScreen(new OptionsScreen(this.app, this))));
    const lan = this.add(new Button(cx + 4, y + 72, 98, 20, tr('menu.shareToLan'), () => {})); lan.active = false;
    this.add(new Button(cx - 102, y + 96, 204, 20, tr('menu.returnToMenu'), () => this.app.saveAndQuit()));
  }
  renderContent(c: UiCtx): void { c.g.centered(this.title, this.width / 2, 40, 0xffffffff); }
  onClose(): void { this.app.resumeGame(); }
}

// ---------------------------------------------------------------------------------------------
export class OptionsScreen extends Screen {
  constructor(app: AppApi, readonly parent: Screen) { super(app); this.title = tr('options.title'); }
  build(): void {
    const o = this.app.options, cx = this.width / 2;
    this.add(new Slider(cx - 155, 48 - 6, 150, 20, (o.fov - 30) / 80, (v) => tr('options.generic_value', tr('options.fov'), Math.round(30 + v * 80) === 70 ? tr('options.fov.min') === 'options.fov.min' ? '70' : 'Normal' : String(Math.round(30 + v * 80))),
      (v) => { o.fov = Math.round(30 + v * 80); this.app.applyOptions(); }, 80));
    const diff = this.add(new Button(cx + 5, 48 - 6, 150, 20, tr('options.online'), () => {})); diff.active = false;
    const rows: [string, () => void, boolean][] = [
      ['options.skinCustomisation', () => {}, false], ['options.sounds', () => this.app.setScreen(new SoundOptionsScreen(this.app, this)), true],
      ['options.video', () => this.app.setScreen(new VideoSettingsScreen(this.app, this)), true], ['options.controls', () => {}, false],
      ['options.language', () => {}, false], ['options.chat', () => {}, false],
      ['options.resourcepack', () => {}, false], ['options.accessibility', () => {}, false],
      ['options.telemetry', () => {}, false], ['options.credits_and_attribution', () => {}, false],
    ];
    rows.forEach(([k, fn, act], i) => {
      const b = this.add(new Button(i % 2 === 0 ? cx - 155 : cx + 5, 48 + 24 + 12 + Math.floor(i / 2) * 24 - 6, 150, 20, tr(k), fn));
      b.active = act;
    });
    this.add(new Button(cx - 100, this.height - 27, 200, 20, tr('gui.done'), () => this.onClose()));
  }
  renderContent(c: UiCtx): void { c.g.centered(this.title, this.width / 2, 15, 0xffffffff); }
  onClose(): void { this.app.saveOptions(); this.app.setScreen(this.parent); }
}

export class VideoSettingsScreen extends Screen {
  constructor(app: AppApi, readonly parent: Screen) { super(app); this.title = tr('options.videoTitle'); }
  build(): void {
    const o = this.app.options, cx = this.width / 2;
    const col = (i: number) => (i % 2 === 0 ? cx - 155 : cx + 5);
    const row = (i: number) => 32 + Math.floor(i / 2) * 25;
    const items: Widget[] = [];
    const onoff = (v: boolean) => tr(v ? 'options.on' : 'options.off');
    let i = 0;
    const add = (w: Widget) => { w.x = col(i); w.y = row(i); i++; items.push(this.add(w)); };
    add(new Slider(0, 0, 150, 20, (o.renderDistance - 2) / 30, (v) => tr('options.renderDistance') + ': ' + tr('options.chunks', Math.round(2 + v * 30)), (v) => { o.renderDistance = Math.round(2 + v * 30); this.app.applyOptions(); }, 30));
    add(new Slider(0, 0, 150, 20, (o.simulationDistance - 5) / 27, (v) => tr('options.simulationDistance') + ': ' + tr('options.chunks', Math.round(5 + v * 27)), (v) => { o.simulationDistance = Math.round(5 + v * 27); }, 27));
    add(new Slider(0, 0, 150, 20, o.gamma, (v) => tr('options.gamma') + ': ' + (v === 0 ? tr('options.gamma.min') : v === 1 ? tr('options.gamma.max') : Math.round(v * 100) === 50 ? tr('options.gamma.default') : '+' + Math.round(v * 100) + '%'), (v) => { o.gamma = v; this.app.applyOptions(); }, 100));
    add(new Slider(0, 0, 150, 20, o.guiScale / 4, (v) => tr('options.guiScale') + ': ' + (Math.round(v * 4) === 0 ? tr('options.guiScale.auto') : String(Math.round(v * 4))), (v) => { o.guiScale = Math.round(v * 4); this.app.applyOptions(); }, 4));
    add(new CycleButton(0, 0, 150, 20, tr('options.particles'), ['all', 'decreased', 'minimal'] as const as unknown as Options['particles'][], ['all', 'decreased', 'minimal'].indexOf(o.particles), (v) => tr('options.particles.' + v), (v) => { o.particles = v; }));
    add(new CycleButton(0, 0, 150, 20, tr('options.renderClouds'), ['off', 'fast', 'fancy'] as Options['clouds'][], ['off', 'fast', 'fancy'].indexOf(o.clouds), (v) => tr(v === 'off' ? 'options.off' : 'options.clouds.' + v), (v) => { o.clouds = v; this.app.applyOptions(); }));
    add(new CycleButton(0, 0, 150, 20, tr('options.ao'), [false, true], o.smoothLighting ? 1 : 0, onoff, (v) => { o.smoothLighting = v; this.app.applyOptions(); }));
    add(new CycleButton(0, 0, 150, 20, tr('options.viewBobbing'), [false, true], o.viewBobbing ? 1 : 0, onoff, (v) => { o.viewBobbing = v; }));
    add(new Slider(0, 0, 150, 20, o.biomeBlend / 7, (v) => tr('options.biomeBlendRadius') + ': ' + (Math.round(v * 7) === 0 ? tr('options.off') : (Math.round(v * 7) * 2 + 1) + 'x' + (Math.round(v * 7) * 2 + 1)), (v) => { o.biomeBlend = Math.round(v * 7); this.app.applyOptions(); }, 7));
    add(new Slider(0, 0, 150, 20, (o.maxFps - 10) / 250, (v) => tr('options.framerateLimit') + ': ' + (Math.round(10 + v * 250) >= 260 ? tr('options.framerateLimit.max') : tr('options.framerate', Math.round(10 + v * 250))), (v) => { o.maxFps = Math.round(10 + v * 250); }, 25));
    add(new Slider(0, 0, 150, 20, o.menuBlur / 10, (v) => tr('options.accessibility.menu_background_blurriness') + ': ' + Math.round(v * 10), (v) => { o.menuBlur = Math.round(v * 10); }, 10));
    const sh = new CycleButton(0, 0, 150, 20, 'Sun Shadows', [false, true], o.shadows ? 1 : 0, onoff, (v) => { o.shadows = v; this.app.applyOptions(); });
    sh.tooltipLines = ['Not part of vanilla Java Edition (see DEVIATIONS.md).'];
    add(sh);
    this.add(new Button(cx - 100, this.height - 27, 200, 20, tr('gui.done'), () => this.onClose()));
  }
  renderContent(c: UiCtx): void { c.g.centered(this.title, this.width / 2, 15, 0xffffffff); }
  onClose(): void { this.app.saveOptions(); this.app.setScreen(this.parent); }
}

export class SoundOptionsScreen extends Screen {
  constructor(app: AppApi, readonly parent: Screen) { super(app); this.title = tr('options.sounds.title'); }
  build(): void {
    const o = this.app.options, cx = this.width / 2;
    const cats = ['master', 'music', 'record', 'weather', 'block', 'hostile', 'neutral', 'player', 'ambient', 'voice', 'ui'];
    cats.forEach((cat, i) => {
      const x = i === 0 ? cx - 155 : (i - 1) % 2 === 0 ? cx - 155 : cx + 5;
      const y = i === 0 ? 32 : 32 + 25 + Math.floor((i - 1) / 2) * 25;
      const w = i === 0 ? 310 : 150;
      this.add(new Slider(x, y, w, 20, o.volume[cat] ?? 1, (v) => tr('soundCategory.' + cat) + ': ' + (v === 0 ? tr('options.off') : Math.round(v * 100) + '%'), (v) => { o.volume[cat] = v; this.app.applyOptions(); }, 100));
    });
    this.add(new Button(cx - 100, this.height - 27, 200, 20, tr('gui.done'), () => this.onClose()));
  }
  renderContent(c: UiCtx): void { c.g.centered(this.title, this.width / 2, 15, 0xffffffff); }
  onClose(): void { this.app.saveOptions(); this.app.setScreen(this.parent); }
}

// ---------------------------------------------------------------------------------------------
export class DeathScreen extends Screen {
  delay = 0;
  constructor(app: AppApi, readonly cause: string, readonly hardcore: boolean, readonly score: number) { super(app); }
  build(): void {
    const cx = this.width / 2, y = this.height / 4 + 72;
    const r = this.add(new Button(cx - 100, y, 200, 20, this.hardcore ? tr('deathScreen.spectate') : tr('deathScreen.respawn'), () => this.app.respawn()));
    const t = this.add(new Button(cx - 100, y + 24, 200, 20, tr('deathScreen.titleScreen'), () => this.app.saveAndQuit()));
    r.active = t.active = this.delay >= 20;
  }
  tick(): void { super.tick(); this.delay++; if (this.delay === 20) for (const w of this.widgets) w.active = true; }
  renderBackground(c: UiCtx): void { c.g.fillGradient(0, 0, this.width, this.height, 0x60500000, 0xa0803030); }
  renderContent(c: UiCtx): void {
    const g = c.g;
    (g as any).transformed(this.width / 2, 30, 0, 2, () => g.centered(tr(this.hardcore ? 'deathScreen.title.hardcore' : 'deathScreen.title'), 0, 0, 0xffffffff));
    g.centered(this.cause, this.width / 2, 85, 0xffffffff);
    g.centered(tr('deathScreen.score.value', '§e' + this.score), this.width / 2, 100, 0xffffffff);
  }
  closeOnEsc(): boolean { return false; }
  isPauseScreen(): boolean { return false; }
}

export { drawTooltip };
