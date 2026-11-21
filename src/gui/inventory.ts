// AbstractContainerScreen + menus: InventoryMenu (2x2 crafting, armour, offhand), CraftingMenu (3x3),
// ChestMenu (generic_54), FurnaceMenu, CreativeModeInventoryScreen. Slot coordinates and click
// semantics follow AbstractContainerMenu.doClick (pickup / split / quick-move / swap / quick-craft drag / pickup-all).
import { Screen, type AppApi } from './screens';
import { EditBox, type UiCtx } from './widgets';
import { tr } from './i18n';
import type { Game } from '../game/game';
import type { ItemStack } from '../game/items';
import { Hud } from './hud';

export interface Slot { x: number; y: number; get(): ItemStack | null; set(s: ItemStack | null): void; mayPlace?(s: ItemStack): boolean; output?: boolean; maxStack?: number; empty?: string }

const same = (a: ItemStack | null, b: ItemStack | null) => !!a && !!b && a.id === b.id && !a.damage && !b.damage && JSON.stringify(a.components ?? {}) === JSON.stringify(b.components ?? {});

// ---------------------------------------------------------------------------------------------
// Recipes (crafting_shaped / crafting_shapeless / crafting_transmute) with item tags
export class Recipes {
  private shaped: { w: number; h: number; cells: (Set<number> | null)[]; out: ItemStack }[] = [];
  private shapeless: { ing: Set<number>[]; out: ItemStack }[] = [];
  readonly smelting = new Map<number, { out: ItemStack; xp: number; time: number }>();
  constructor(readonly game: Game) {
    const items = game.items, tags = game.b.tags;
    const tagCache = new Map<string, Set<number>>();
    const itemTag = (t: string): Set<number> => {
      t = t.replace('#', '').replace('minecraft:', '');
      let s = tagCache.get(t); if (s) return s;
      s = new Set(); tagCache.set(t, s);
      for (const v0 of tags['item/' + t]?.values ?? []) { const v = typeof v0 === 'string' ? v0 : v0.id; if (v.startsWith('#')) for (const x of itemTag(v)) s.add(x); else { const i = items.byName.get(v.replace('minecraft:', '')); if (i !== undefined) s.add(i); } }
      return s;
    };
    const ingredient = (j: any): Set<number> => {
      if (Array.isArray(j)) { const s = new Set<number>(); for (const x of j) for (const v of ingredient(x)) s.add(v); return s; }
      if (typeof j === 'string') return j.startsWith('#') ? itemTag(j) : new Set([items.byName.get(j.replace('minecraft:', ''))!].filter((x) => x !== undefined));
      if (j.tag) return itemTag(j.tag);
      if (j.item) return ingredient(j.item);
      return new Set();
    };
    const result = (r: any): ItemStack | null => { const id = items.byName.get(String(r.id ?? r.item).replace('minecraft:', '')); return id === undefined ? null : { id, count: r.count ?? 1 }; };
    for (const r of Object.values(game.b.recipes) as any[]) {
      const t = String(r.type).replace('minecraft:', '');
      if (t === 'crafting_shaped') {
        const out = result(r.result); if (!out) continue;
        const pat: string[] = r.pattern; const h = pat.length, w = Math.max(...pat.map((p) => p.length));
        const cells: (Set<number> | null)[] = [];
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const ch = pat[y][x] ?? ' '; cells.push(ch === ' ' ? null : ingredient(r.key[ch])); }
        this.shaped.push({ w, h, cells, out });
      } else if (t === 'crafting_shapeless') {
        const out = result(r.result); if (!out) continue;
        this.shapeless.push({ ing: r.ingredients.map(ingredient), out });
      } else if (t === 'crafting_transmute') {
        const out = result(r.result); if (!out) continue;
        this.shapeless.push({ ing: [ingredient(r.input), ingredient(r.material)], out });
      } else if (t === 'smelting') {
        const out = result(r.result); if (!out) continue;
        for (const i of ingredient(r.ingredient)) this.smelting.set(i, { out, xp: r.experience ?? 0, time: r.cookingtime ?? 200 });
      }
    }
  }
  /** CraftingInput: trimmed grid, shaped (with mirroring) then shapeless. */
  match(grid: (ItemStack | null)[], gw: number): ItemStack | null {
    const gh = grid.length / gw;
    let x0 = gw, y0 = gh, x1 = -1, y1 = -1;
    for (let i = 0; i < grid.length; i++) if (grid[i]) { const x = i % gw, y = (i / gw) | 0; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (x1 < 0) return null;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const at = (x: number, y: number) => grid[(y0 + y) * gw + x0 + x];
    for (const r of this.shaped) {
      if (r.w !== w || r.h !== h) continue;
      for (const mirror of [false, true]) {
        let ok = true;
        for (let y = 0; y < h && ok; y++) for (let x = 0; x < w && ok; x++) {
          const cell = r.cells[y * w + (mirror ? w - 1 - x : x)], s = at(x, y);
          if (cell ? !s || !cell.has(s.id) : !!s) ok = false;
        }
        if (ok) return { ...r.out };
      }
    }
    const items = grid.filter((s): s is ItemStack => !!s);
    for (const r of this.shapeless) {
      if (r.ing.length !== items.length) continue;
      const used = new Array(items.length).fill(false);
      let ok = true;
      for (const ing of r.ing) { const i = items.findIndex((s, k) => !used[k] && ing.has(s.id)); if (i < 0) { ok = false; break; } used[i] = true; }
      if (ok) return { ...r.out };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
export abstract class ContainerScreen extends Screen {
  imageW = 176; imageH = 166; left = 0; top = 0;
  slots: Slot[] = [];
  carried: ItemStack | null = null;
  hoveredSlot: Slot | null = null;
  private dragSlots: Slot[] = []; private dragButton = -1;
  private lastClick = 0; private lastClickSlot: Slot | null = null;
  texture = 'gui/container/inventory.png';
  titleText = '';
  transparentInWorld = true;
  constructor(app: AppApi, readonly game: Game) { super(app); }
  build(): void {
    this.left = Math.floor((this.width - this.imageW) / 2); this.top = Math.floor((this.height - this.imageH) / 2);
    this.slots = []; this.addSlots();
  }
  abstract addSlots(): void;
  isPauseScreen(): boolean { return false; }
  typing(): boolean { return false; }
  inv(i: number): Slot {
    const p = this.game.player.inventory;
    const x = i < 9 ? 8 + i * 18 : 8 + ((i - 9) % 9) * 18;
    const y = i < 9 ? this.imageH - 24 : this.imageH - 82 + Math.floor((i - 9) / 9) * 18;
    return { x, y, get: () => p.slots[i], set: (s) => { p.slots[i] = s; } };
  }
  playerSlots(): void { for (let i = 9; i < 36; i++) this.slots.push(this.inv(i)); for (let i = 0; i < 9; i++) this.slots.push(this.inv(i)); }

  renderBackground(c: UiCtx): void {
    super.renderBackground(c);
    const t = c.g.texture(this.texture);
    if (t) c.g.blitL(t, this.left, this.top, this.imageW, this.imageH, 0, 0, this.imageW, this.imageH, 256, 256);
  }
  renderLabels(c: UiCtx): void {
    if (this.titleText) c.g.text(this.titleText, this.left + 8, this.top + 6, 0xff404040, false);
    c.g.text(tr('container.inventory'), this.left + 8, this.top + this.imageH - 96 + 2, 0xff404040, false);
  }
  renderContent(c: UiCtx): void {
    const g = c.g;
    this.renderExtra(c);
    this.renderLabels(c);
    this.hoveredSlot = null;
    for (const s of this.slots) {
      const x = this.left + s.x, y = this.top + s.y;
      if (c.mx >= x - 1 && c.mx < x + 17 && c.my >= y - 1 && c.my < y + 17) this.hoveredSlot = s;
      if (!s.get() && s.empty) g.sprite(s.empty, x, y, 16, 16);
    }
    if (this.hoveredSlot) g.sprite('container/slot_highlight_back', this.left + this.hoveredSlot.x - 4, this.top + this.hoveredSlot.y - 4, 24, 24);
    const hud = new Hud(g, this.game);
    const list: [ItemStack, number, number][] = [];
    for (const s of this.slots) { const st = s.get(); if (st) list.push([st, this.left + s.x, this.top + s.y]); }
    hud.renderItems(list);
    if (this.hoveredSlot) g.sprite('container/slot_highlight_front', this.left + this.hoveredSlot.x - 4, this.top + this.hoveredSlot.y - 4, 24, 24);
    if (this.carried) hud.renderItems([[this.carried, c.mx - 8, c.my - 8]]);
    if (!this.carried && this.hoveredSlot?.get()) c.tooltip([hud.itemName(this.hoveredSlot.get()!)]);
  }
  renderExtra(_c: UiCtx): void {}
  renderTooltips(): void {}

  private max(s: ItemStack, slot?: Slot): number { return Math.min(this.game.items.maxStack(s.id), slot?.maxStack ?? 99); }

  mouseDown(c: UiCtx, b: number): boolean {
    const s = this.hoveredSlot;
    if (!s) {
      const inside = c.mx >= this.left && c.mx < this.left + this.imageW && c.my >= this.top && c.my < this.top + this.imageH;
      if (!inside && this.carried) { this.drop(b === 1); return true; }
      return super.mouseDown(c, b);
    }
    const now = performance.now();
    const dbl = b === 0 && this.lastClickSlot === s && now - this.lastClick < 250;
    this.lastClick = now; this.lastClickSlot = s;
    if ((window.event as MouseEvent | undefined)?.shiftKey) { this.quickMove(s); return true; }
    if (dbl && this.carried) { this.collectAll(); return true; }
    if (this.carried && !s.output) { this.dragSlots = [s]; this.dragButton = b; return true; }
    this.click(s, b);
    return true;
  }
  mouseDrag(c: UiCtx): void {
    if (this.dragButton < 0 || !this.carried) return;
    const s = this.hoveredSlot ?? this.slotAt(c.mx, c.my);
    if (s && !s.output && !this.dragSlots.includes(s) && (!s.get() || same(s.get(), this.carried)) && (s.mayPlace?.(this.carried) ?? true)) this.dragSlots.push(s);
  }
  mouseUp(_c: UiCtx, b: number): void {
    if (this.dragButton !== b) return;
    const slots = this.dragSlots; this.dragSlots = []; this.dragButton = -1;
    if (slots.length === 1) { this.click(slots[0], b); return; }
    if (!this.carried || !slots.length) return;
    // AbstractContainerMenu quick-craft: left splits evenly, right places one each
    const total = this.carried.count;
    const per = b === 0 ? Math.floor(total / slots.length) : 1;
    let left = total;
    for (const s of slots) {
      if (left <= 0) break;
      const cur = s.get();
      const room = this.max(this.carried, s) - (cur ? cur.count : 0);
      const n = Math.min(per, room, left);
      if (n <= 0) continue;
      s.set(cur ? { ...cur, count: cur.count + n } : { ...this.carried, count: n });
      left -= n;
    }
    this.carried = left > 0 ? { ...this.carried, count: left } : null;
    this.changed();
  }
  private slotAt(mx: number, my: number): Slot | null {
    for (const s of this.slots) { const x = this.left + s.x, y = this.top + s.y; if (mx >= x - 1 && mx < x + 17 && my >= y - 1 && my < y + 17) return s; }
    return null;
  }

  /** ClickType.PICKUP */
  click(s: Slot, b: number): void {
    const cur = s.get();
    if (s.output) { this.takeOutput(s, false); return; }
    if (!this.carried) {
      if (!cur) return;
      if (b === 0) { this.carried = cur; s.set(null); }
      else { const half = Math.ceil(cur.count / 2); this.carried = { ...cur, count: half }; s.set(cur.count - half > 0 ? { ...cur, count: cur.count - half } : null); }
    } else if (s.mayPlace && !s.mayPlace(this.carried)) return;
    else if (!cur) {
      if (b === 0) { const n = Math.min(this.carried.count, this.max(this.carried, s)); s.set({ ...this.carried, count: n }); this.carried = this.carried.count - n > 0 ? { ...this.carried, count: this.carried.count - n } : null; }
      else { s.set({ ...this.carried, count: 1 }); this.carried = this.carried.count > 1 ? { ...this.carried, count: this.carried.count - 1 } : null; }
    } else if (same(cur, this.carried)) {
      const room = this.max(cur, s) - cur.count;
      const n = Math.min(room, b === 0 ? this.carried.count : 1);
      if (n > 0) { s.set({ ...cur, count: cur.count + n }); this.carried = this.carried.count - n > 0 ? { ...this.carried, count: this.carried.count - n } : null; }
    } else { s.set(this.carried); this.carried = cur; }
    this.changed();
  }
  protected takeOutput(s: Slot, shift: boolean): void {
    const out = s.get(); if (!out) return;
    if (shift) {
      let n = 0;
      while (s.get() && n++ < 64) { const o = s.get()!; if (!this.moveToInventory({ ...o })) break; this.consumeCraft(); }
      return;
    }
    if (this.carried && (!same(this.carried, out) || this.carried.count + out.count > this.max(out))) return;
    this.carried = this.carried ? { ...this.carried, count: this.carried.count + out.count } : { ...out };
    this.consumeCraft();
  }
  consumeCraft(): void {}
  changed(): void {}
  /** quick move (shift-click): container <-> player inventory, hotbar <-> main */
  quickMove(s: Slot): void {
    const st = s.get(); if (!st) return;
    if (s.output) { this.takeOutput(s, true); return; }
    const idx = this.slots.indexOf(s);
    const playerStart = this.slots.length - 36;
    let targets: Slot[];
    if (idx >= playerStart) {
      const own = this.slots.slice(0, playerStart).filter((t) => !t.output && (t.mayPlace?.(st) ?? true));
      targets = own.length ? own : idx >= this.slots.length - 9 ? this.slots.slice(playerStart, this.slots.length - 9) : this.slots.slice(this.slots.length - 9);
    } else targets = [...this.slots.slice(this.slots.length - 9).reverse(), ...this.slots.slice(playerStart, this.slots.length - 9).reverse()].reverse();
    let rest = st.count;
    for (const pass of [0, 1]) for (const t of targets) {
      if (rest <= 0) break;
      const c = t.get();
      if (pass === 0 && c && same(c, st)) { const n = Math.min(rest, this.max(st, t) - c.count); if (n > 0) { t.set({ ...c, count: c.count + n }); rest -= n; } }
      if (pass === 1 && !c) { const n = Math.min(rest, this.max(st, t)); t.set({ ...st, count: n }); rest -= n; }
    }
    s.set(rest > 0 ? { ...st, count: rest } : null);
    this.changed();
  }
  private moveToInventory(st: ItemStack): boolean { return this.game.addToInventory(st) && st.count <= 0; }
  private collectAll(): void {
    const c = this.carried!;
    for (const s of this.slots) {
      if (s.output) continue;
      const cur = s.get();
      if (cur && same(cur, c) && c.count < this.max(c)) { const n = Math.min(cur.count, this.max(c) - c.count); c.count += n; s.set(cur.count - n > 0 ? { ...cur, count: cur.count - n } : null); }
    }
    this.changed();
  }
  private drop(one: boolean): void {
    const c = this.carried!; const n = one ? 1 : c.count;
    const p = this.game.player;
    this.game.spawnItem(p.x, p.y + p.eyeHeight - 0.3, p.z, { ...c, count: n }, true);
    this.carried = c.count - n > 0 ? { ...c, count: c.count - n } : null;
  }
  key(e: KeyboardEvent): boolean {
    const s = this.hoveredSlot;
    if (s && /^Digit[1-9]$/.test(e.code)) { // ClickType.SWAP with hotbar
      const i = +e.code.slice(5) - 1;
      const hb = this.game.player.inventory;
      const a = s.get(), bb = hb.slots[i];
      if (s.output) return true;
      s.set(bb); hb.slots[i] = a; this.changed(); return true;
    }
    if (s && e.code === this.app.options.keys.drop && s.get() && !this.carried) {
      const st = s.get()!; const n = e.ctrlKey ? st.count : 1;
      const p = this.game.player;
      this.game.spawnItem(p.x, p.y + p.eyeHeight - 0.3, p.z, { ...st, count: n }, true);
      s.set(st.count - n > 0 ? { ...st, count: st.count - n } : null); this.changed(); return true;
    }
    return super.key(e);
  }
  onClose(): void {
    if (this.carried) { this.game.addToInventory(this.carried); if (this.carried.count > 0) { const p = this.game.player; this.game.spawnItem(p.x, p.y + 1.3, p.z, this.carried, true); } this.carried = null; }
    this.closed();
    this.app.setScreen(null);
  }
  closed(): void {}
}

/** Crafting grid + result shared by inventory (2x2) and crafting table (3x3). */
abstract class CraftingScreenBase extends ContainerScreen {
  grid: (ItemStack | null)[] = [];
  result: ItemStack | null = null;
  constructor(app: AppApi, game: Game, readonly gw: number) { super(app, game); this.grid = new Array(gw * gw).fill(null); }
  recipes(): Recipes { const g = this.game as any; return (g.recipes ??= new Recipes(this.game)); }
  changed(): void { this.result = this.recipes().match(this.grid, this.gw); }
  consumeCraft(): void {
    for (let i = 0; i < this.grid.length; i++) {
      const s = this.grid[i]; if (!s) continue;
      const rem = this.game.items.comp(s.id, 'use_remainder');
      s.count--;
      if (s.count <= 0) this.grid[i] = rem ? { id: this.game.items.id(rem.id), count: rem.count ?? 1 } : null;
    }
    this.changed();
  }
  gridSlot(i: number, x: number, y: number): Slot { return { x, y, get: () => this.grid[i], set: (s) => { this.grid[i] = s; } }; }
  resultSlot(x: number, y: number): Slot { return { x, y, output: true, get: () => this.result, set: () => {} }; }
  closed(): void {
    for (let i = 0; i < this.grid.length; i++) if (this.grid[i]) { const s = this.grid[i]!; this.game.addToInventory(s); if (s.count > 0) this.game.spawnItem(this.game.player.x, this.game.player.y + 1.3, this.game.player.z, s, true); this.grid[i] = null; }
  }
}

export class InventoryScreen extends CraftingScreenBase {
  constructor(app: AppApi, game: Game) { super(app, game, 2); }
  addSlots(): void {
    this.slots.push(this.resultSlot(154, 28));
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) this.slots.push(this.gridSlot(i * 2 + j, 98 + j * 18, 18 + i * 18));
    const inv = this.game.player.inventory;
    const empty = ['container/slot/helmet', 'container/slot/chestplate', 'container/slot/leggings', 'container/slot/boots'];
    const kinds = ['head', 'chest', 'legs', 'feet'];
    for (let i = 0; i < 4; i++) {
      const idx = 39 - i;
      this.slots.push({ x: 8, y: 8 + i * 18, maxStack: 1, empty: empty[i], get: () => inv.slots[idx], set: (s) => { inv.slots[idx] = s; },
        mayPlace: (s) => this.game.items.comp(s.id, 'equippable')?.slot === kinds[i] });
    }
    this.slots.push({ x: 77, y: 62, empty: 'container/slot/shield', get: () => inv.slots[40], set: (s) => { inv.slots[40] = s; } });
    this.playerSlots();
  }
  renderLabels(c: UiCtx): void { c.g.text(tr('container.crafting'), this.left + 97, this.top + 8, 0xff404040, false); }
}

export class CraftingTableScreen extends CraftingScreenBase {
  texture = 'gui/container/crafting_table.png';
  constructor(app: AppApi, game: Game) { super(app, game, 3); this.titleText = tr('container.crafting'); }
  addSlots(): void {
    this.slots.push(this.resultSlot(124, 35));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) this.slots.push(this.gridSlot(i * 3 + j, 30 + j * 18, 17 + i * 18));
    this.playerSlots();
  }
  renderLabels(c: UiCtx): void {
    c.g.text(this.titleText, this.left + 29, this.top + 6, 0xff404040, false);
    c.g.text(tr('container.inventory'), this.left + 8, this.top + this.imageH - 96 + 2, 0xff404040, false);
  }
}

export class ChestScreen extends ContainerScreen {
  texture = 'gui/container/generic_54.png';
  constructor(app: AppApi, game: Game, readonly items: (ItemStack | null)[], readonly rows: number, title: string) {
    super(app, game); this.imageH = 114 + rows * 18; this.titleText = title;
  }
  addSlots(): void {
    for (let i = 0; i < this.rows; i++) for (let j = 0; j < 9; j++) { const k = i * 9 + j; this.slots.push({ x: 8 + j * 18, y: 18 + i * 18, get: () => this.items[k], set: (s) => { this.items[k] = s; } }); }
    this.playerSlots();
  }
  renderBackground(c: UiCtx): void {
    Screen.prototype.renderBackground.call(this, c);
    const t = c.g.texture(this.texture);
    if (t) {
      c.g.blitL(t, this.left, this.top, this.imageW, this.rows * 18 + 17, 0, 0, this.imageW, this.rows * 18 + 17, 256, 256);
      c.g.blitL(t, this.left, this.top + this.rows * 18 + 17, this.imageW, 96, 0, 126, this.imageW, 96, 256, 256);
    }
  }
}

export class FurnaceScreen extends ContainerScreen {
  texture = 'gui/container/furnace.png';
  constructor(app: AppApi, game: Game, readonly f: { items: (ItemStack | null)[]; burn: number; burnMax: number; cook: number; cookMax: number }, title: string) { super(app, game); this.titleText = title; }
  addSlots(): void {
    const f = this.f;
    this.slots.push({ x: 56, y: 17, get: () => f.items[0], set: (s) => { f.items[0] = s; } });
    this.slots.push({ x: 56, y: 53, get: () => f.items[1], set: (s) => { f.items[1] = s; }, mayPlace: (s) => !!this.game.items.comp(s.id, 'cooking_fuel') || this.game.items.name(s.id) === 'bucket' });
    this.slots.push({ x: 116, y: 35, get: () => f.items[2], set: (s) => { f.items[2] = s; }, mayPlace: () => false });
    this.playerSlots();
  }
  renderExtra(c: UiCtx): void {
    const f = this.f, g = c.g;
    if (f.burn > 0) { const h = Math.ceil((f.burn / Math.max(1, f.burnMax)) * 13) + 1; const sp = g.atlas.sprites['container/furnace/lit_progress']; const [ax, ay] = sp.frames[0]; g.blit(g.atlasTex, this.left + 56, this.top + 36 + 14 - h, 14, h, ax, ay + 14 - h, 14, h); }
    const w = Math.ceil((f.cook / Math.max(1, f.cookMax)) * 24);
    if (w > 0) g.spritePart('container/furnace/burn_progress', this.left + 79, this.top + 34, w, 16);
  }
}

// ---------------------------------------------------------------------------------------------
const TABS = ['building_blocks', 'colored_blocks', 'natural_blocks', 'functional_blocks', 'redstone_blocks', 'hotbar', 'search',
  'tools_and_utilities', 'combat', 'food_and_drinks', 'ingredients', 'spawn_eggs', 'op_blocks', 'inventory'];
const TAB_ICONS: Record<string, string> = { building_blocks: 'bricks', colored_blocks: 'cyan_wool', natural_blocks: 'grass_block', functional_blocks: 'oak_sign', redstone_blocks: 'redstone',
  hotbar: 'bookshelf', search: 'compass', tools_and_utilities: 'diamond_pickaxe', combat: 'netherite_sword', food_and_drinks: 'golden_apple', ingredients: 'iron_ingot', spawn_eggs: 'pig_spawn_egg', op_blocks: 'command_block', inventory: 'chest' };

/** CreativeModeTabs contents are built in code; this reconstruction classifies items by components and names. */
function classify(game: Game, id: number): string {
  const it = game.items, n = it.name(id);
  if (/spawn_egg$/.test(n)) return 'spawn_eggs';
  if (/^(command_block|chain_command_block|repeating_command_block|structure_block|structure_void|jigsaw|barrier|light|debug_stick|command_block_minecart|test_block|test_instance_block)$/.test(n)) return 'op_blocks';
  if (it.comp(id, 'food') || /potion$|^milk_bucket$|^cake$/.test(n)) return 'food_and_drinks';
  if (/_sword$|_spear$|^bow$|^crossbow$|^trident$|^mace$|^shield$|_helmet$|_chestplate$|_leggings$|_boots$|^arrow$|_arrow$|^totem_of_undying$|_horse_armor$|^wolf_armor$|^turtle_helmet$|_nautilus_armor$|^wind_charge$|^snowball$|^egg$/.test(n)) return 'combat';
  if (it.comp(id, 'tool') || /_axe$|_shovel$|_hoe$|_pickaxe$|bucket$|^flint_and_steel$|^shears$|^fishing_rod$|^compass$|^clock$|^map$|^spyglass$|^brush$|^lead$|^name_tag$|_boat$|_raft$|minecart$|^saddle$|^elytra$|_bundle$|^bundle$|^book$|^writable_book$|^ender_pearl$|^ender_eye$|^firework_rocket$|^music_disc|^goat_horn$|_harness$/.test(n)) return 'tools_and_utilities';
  const block = it.blockOf[id];
  if (block < 0) return 'ingredients';
  if (/redstone|repeater|comparator|piston|observer|hopper|dropper|dispenser|lever|_button$|pressure_plate$|tripwire_hook|daylight_detector|target|note_block|tnt|_rail$|^rail$|lectern|sculk_sensor|lightning_rod|crafter|copper_bulb|trapped_chest|_door$|_trapdoor$|_fence_gate$/.test(n)) return 'redstone_blocks';
  if (/^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_/.test(n)) return 'colored_blocks';
  if (/_sign$|chest$|barrel|furnace|smoker|crafting_table|table$|anvil|grindstone|loom|stonecutter|beacon|bed$|bell|campfire|lantern|torch|_shelf$|candle|bookshelf|composter|cauldron|brewing_stand|jukebox|end_portal_frame|ender_chest|shulker_box|respawn_anchor|lodestone|ladder|scaffolding|_banner$|_head$|_skull$|flower_pot|painting|item_frame|armor_stand|conduit|vault|trial_spawner|spawner|decorated_pot|chain$|_bars$|lightning|_golem_statue$/.test(n)) return 'functional_blocks';
  if (/_ore$|^stone$|^granite$|^diorite$|^andesite$|^deepslate$|^tuff$|^calcite$|^dirt$|^grass_block$|^podzol$|^mycelium$|^sand$|^red_sand$|^gravel$|^clay$|_log$|_leaves$|_sapling$|^short_grass$|^fern$|flower|tulip|poppy|dandelion|orchid|allium|bluet|daisy|lily|rose|peony|lilac|sunflower|mushroom|^cactus$|^sugar_cane$|^vine$|^ice$|^snow|^obsidian$|^netherrack$|^soul_|^end_stone$|_nylium$|_fungus$|_roots$|^moss_block$|^mud$|^sculk$|seeds$|^bamboo$|coral|^kelp$|^seagrass$|^sea_pickle$|^dripstone|^pointed_dripstone$|amethyst|^bedrock$|^sponge|^honeycomb_block$|^bee_nest$|_mushroom_block$|^mushroom_stem$|^sulfur$|^potent_sulfur$|^sulfur_spike$|bush$|^leaf_litter$|^dead_bush$|petals|wildflowers|^cobweb$|^magma_block$|^glowstone$|^basalt$|^blackstone$|^packed_ice$|^blue_ice$|^coarse_dirt$|^rooted_dirt$|^suspicious/.test(n)) return 'natural_blocks';
  return 'building_blocks';
}

export class CreativeScreen extends ContainerScreen {
  tab = 'building_blocks';
  scrollRow = 0;
  private list: number[] = [];
  private search: EditBox | null = null;
  private scrolling = false;
  constructor(app: AppApi, game: Game) { super(app, game); this.imageW = 195; this.imageH = 136; }
  typing(): boolean { return this.tab === 'search' && !!this.search?.focused; }
  private all(): number[] { const g = this.game as any; return (g.creativeItems ??= this.game.items.names.map((_, i) => i).filter((i) => this.game.items.name(i) !== 'air')); }
  private refresh(): void {
    const q = (this.search?.value ?? '').toLowerCase();
    if (this.tab === 'search') this.list = this.all().filter((i) => !q || (new Hud(this.app.g, this.game)).itemName({ id: i, count: 1 }).toLowerCase().includes(q));
    else this.list = this.all().filter((i) => classify(this.game, i) === this.tab);
  }
  build(): void {
    super.build();
    this.texture = this.tab === 'search' ? 'gui/container/creative_inventory/tab_item_search.png' : this.tab === 'inventory' ? 'gui/container/creative_inventory/tab_inventory.png' : 'gui/container/creative_inventory/tab_items.png';
    if (this.tab === 'search') {
      this.search = this.add(new EditBox(this.left + 82, this.top + 6, 80, 9));
      this.search.onChange = () => { this.scrollRow = 0; this.refresh(); this.slots = []; this.addSlots(); };
      this.search.focused = true;
    } else this.search = null;
    this.refresh();
  }
  addSlots(): void {
    const inv = this.game.player.inventory;
    if (this.tab === 'inventory') {
      for (let i = 0; i < 4; i++) { const idx = 39 - i; this.slots.push({ x: 54 + Math.floor(i / 2) * 54, y: 6 + (i % 2) * 27, get: () => inv.slots[idx], set: (s) => { inv.slots[idx] = s; } }); }
      this.slots.push({ x: 35, y: 20, get: () => inv.slots[40], set: (s) => { inv.slots[40] = s; } });
      for (let i = 9; i < 36; i++) this.slots.push({ x: 9 + ((i - 9) % 9) * 18, y: 54 + Math.floor((i - 9) / 9) * 18, get: () => inv.slots[i], set: (s) => { inv.slots[i] = s; } });
    } else if (this.tab !== 'hotbar') {
      for (let r = 0; r < 5; r++) for (let col = 0; col < 9; col++) {
        const k = (this.scrollRow + r) * 9 + col;
        this.slots.push({ x: 9 + col * 18, y: 18 + r * 18, output: true, get: () => (k < this.list.length ? { id: this.list[k], count: 1 } : null), set: () => {} });
      }
    }
    for (let i = 0; i < 9; i++) this.slots.push({ x: 9 + i * 18, y: 112, get: () => inv.slots[i], set: (s) => { inv.slots[i] = s; } });
  }
  protected takeOutput(s: Slot, shift: boolean): void {
    const st = s.get(); if (!st) return;
    if (this.carried) { this.carried = null; return; }
    this.carried = { ...st, count: shift ? this.game.items.maxStack(st.id) : 1 };
  }
  click(s: Slot, b: number): void {
    if (s.output && this.carried) { this.carried = null; return; }
    if (s.output && b === 2) { const st = s.get(); if (st) this.carried = { ...st, count: this.game.items.maxStack(st.id) }; return; }
    super.click(s, b);
  }
  private tabPos(i: number): [number, number, boolean] {
    const top = i < 7; const col = i % 7;
    return [this.left + col * 27, top ? this.top - 28 : this.top + this.imageH - 4, top];
  }
  renderBackground(c: UiCtx): void {
    Screen.prototype.renderBackground.call(this, c);
    // unselected tabs behind the panel
    TABS.forEach((t, i) => { if (t !== this.tab && t !== 'op_blocks') { const [x, y, top] = this.tabPos(i); c.g.sprite(`container/creative_inventory/tab_${top ? 'top' : 'bottom'}_unselected_${(i % 7) + 1}`, x, y, 26, 32); } });
    const tex = c.g.texture(this.texture);
    if (tex) c.g.blitL(tex, this.left, this.top, this.imageW, this.imageH, 0, 0, this.imageW, this.imageH, 256, 256);
    const si = TABS.indexOf(this.tab); const [x, y, top] = this.tabPos(si);
    c.g.sprite(`container/creative_inventory/tab_${top ? 'top' : 'bottom'}_selected_${(si % 7) + 1}`, x, y, 26, 32);
    if (this.tab !== 'inventory') {
      const rows = Math.max(0, Math.ceil(this.list.length / 9) - 5);
      const sy = this.top + 18 + (rows ? Math.floor((this.scrollRow / rows) * (112 - 15)) : 0);
      c.g.sprite(rows ? 'container/creative_inventory/scroller' : 'container/creative_inventory/scroller_disabled', this.left + 175, sy, 12, 15);
    }
  }
  renderLabels(c: UiCtx): void {
    if (this.tab !== 'inventory') c.g.text(tr('itemGroup.' + camel(this.tab)), this.left + 8, this.top + 6, 0xff404040, false);
    const hud = new Hud(c.g, this.game);
    const icons: [ItemStack, number, number][] = [];
    TABS.forEach((t, i) => { if (t === 'op_blocks') return; const [x, y, top] = this.tabPos(i); icons.push([{ id: this.game.items.id(TAB_ICONS[t]), count: 1 }, x + 5, y + (top ? 9 : 7)]); });
    hud.renderItems(icons);
  }
  mouseDown(c: UiCtx, b: number): boolean {
    for (let i = 0; i < TABS.length; i++) {
      if (TABS[i] === 'op_blocks') continue;
      const [x, y] = this.tabPos(i);
      if (c.mx >= x && c.mx < x + 26 && c.my >= y && c.my < y + 32) { this.tab = TABS[i]; this.scrollRow = 0; c.playClick(); this.init(this.width, this.height); return true; }
    }
    if (c.mx >= this.left + 175 && c.mx < this.left + 187 && c.my >= this.top + 18 && c.my < this.top + 130) { this.scrolling = true; this.mouseDrag(c); return true; }
    if (this.search && this.search.mouseDown(c, b)) return true;
    return super.mouseDown(c, b);
  }
  mouseDrag(c: UiCtx): void {
    if (this.scrolling) { const rows = Math.max(0, Math.ceil(this.list.length / 9) - 5); this.scrollRow = Math.round(Math.max(0, Math.min(1, (c.my - this.top - 18 - 7.5) / (112 - 15))) * rows); this.slots = []; this.addSlots(); return; }
    super.mouseDrag(c);
  }
  mouseUp(c: UiCtx, b: number): void { this.scrolling = false; super.mouseUp(c, b); }
  scroll(_c: UiCtx, d: number): void {
    const rows = Math.max(0, Math.ceil(this.list.length / 9) - 5);
    this.scrollRow = Math.max(0, Math.min(rows, this.scrollRow + d));
    this.slots = []; this.addSlots();
  }
  char(ch: string): boolean { if (this.search?.focused) { this.search.char(ch); return true; } return false; }
  key(e: KeyboardEvent): boolean { if (this.search?.focused && e.code !== 'Escape') { this.search.key(e); return true; } return super.key(e); }
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
