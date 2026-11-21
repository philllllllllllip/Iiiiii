// Gui (HUD): hotbar, crosshair, health/food/armour/air, experience bar, held item name, debug screen.
import type { GuiRenderer } from './renderer';
import type { Game } from '../game/game';
import type { ItemStack } from '../game/items';
import { tr } from './i18n';
import { MIN_Y } from '../world/chunk';

export class Hud {
  private rand = Math.random;
  debug = false; hidden = false;
  fps = 0;
  private lastHealth = 20; private healthBlinkUntil = 0; private displayHealth = 20; private lastHealthTime = 0;
  constructor(readonly g: GuiRenderer, readonly game: Game) {}

  private vignette = 1;
  chat: { text: string; time: number }[] = [];
  /** Gui.renderVignette + ScreenEffectRenderer.renderWater (drawn even with the HUD hidden). */
  renderEffects(): void {
    const g = this.g, game = this.game, p = game.player, gl = g.gl;
    const w = g.width, h = g.height;
    if (p.eyeInWater) {
      const t = g.texture('misc/underwater.png');
      if (t) {
        const [bl, sky] = game.lightAt(Math.floor(p.x), Math.floor(p.y + p.eyeHeight), Math.floor(p.z));
        const b = Math.max(bl, sky) / 240;
        const u = -p.yaw / 64, v = p.pitch / 64;
        g.blitL(t, 0, 0, w, h, (u + 0) * 16, (v + 0) * 16, 16 * 4, 16 * 4, 16, 16, ((26 << 24) | (Math.round(b * 255) << 16) | (Math.round(b * 255) << 8) | Math.round(b * 255)) >>> 0);
        g.flush();
      }
    }
    if (this.hidden) return;
    // vignette: darkness eases towards 1 - local brightness (0.01 per frame)
    const [, sky] = game.lightAt(Math.floor(p.x), Math.floor(p.y + p.eyeHeight), Math.floor(p.z));
    const target = Math.max(0, Math.min(1, 1 - sky / 240));
    this.vignette += (target - this.vignette) * 0.01;
    const vt = g.texture('misc/vignette.png');
    if (vt) {
      g.flush();
      gl.blendFuncSeparate(gl.ZERO, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ZERO);
      const c = Math.round(this.vignette * 255);
      g.blitL(vt, 0, 0, w, h, 0, 0, 256, 256, 256, 256, (0xff000000 | (c << 16) | (c << 8) | c) >>> 0);
      g.flush();
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  /** ChatComponent: last 10 lines, fade after 200 ticks (opacity (1 - age/200)*10 clamp). */
  renderChat(open: boolean): void {
    const g = this.g, now = this.game.tickNo;
    const lines = this.chat.slice(-(open ? 20 : 10));
    let y = g.height - 40;
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      const age = now - l.time;
      let a = open ? 1 : Math.max(0, Math.min(1, (1 - age / 200) * 10));
      a = a * a;
      if (a <= 0.02) continue;
      g.fill(0, y - 1, 320 + 4, y + 8, ((Math.round(a * 0.5 * 255) << 24) >>> 0));
      g.text(l.text, 2, y, ((Math.round(a * 255) << 24) | 0xffffff) >>> 0);
      y -= 9;
    }
  }

  render(): void {
    const g = this.g, game = this.game, p = game.player;
    this.renderEffects();
    if (this.hidden) return;
    const w = g.width, h = g.height;
    const cx = w / 2;
    // crosshair (inverted blend like vanilla)
    if (!this.debug && p.gameMode !== 'spectator') {
      g.flush();
      const gl = g.gl;
      gl.blendFuncSeparate(gl.ONE_MINUS_DST_COLOR, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ZERO);
      g.sprite('hud/crosshair', Math.floor((w - 15) / 2), Math.floor((h - 15) / 2), 15, 15);
      g.flush();
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    if (p.gameMode === 'spectator') { this.renderDebug(); return; }
    // hotbar
    g.sprite('hud/hotbar', cx - 91, h - 22, 182, 22);
    g.sprite('hud/hotbar_selection', cx - 91 - 1 + p.inventory.selected * 20, h - 22 - 1, 24, 23);
    const items: [ItemStack, number, number][] = [];
    for (let i = 0; i < 9; i++) { const s = p.inventory.slots[i]; if (s) items.push([s, cx - 90 + i * 20 + 2, h - 16 - 3]); }
    const off = p.inventory.slots[40];
    if (off) { g.sprite('hud/hotbar_offhand_left', cx - 91 - 29, h - 23, 29, 24); items.push([off, cx - 91 - 26, h - 16 - 3]); }
    this.renderItems(items);
    const survival = p.gameMode === 'survival' || p.gameMode === 'adventure';
    if (survival) {
      this.renderXp(cx, h);
      this.renderHealthFood(cx, h);
    }
    // held item name (Gui.renderSelectedItemName)
    if (game.heldItemTime > 0 && p.inventory.held) {
      const name = this.itemName(p.inventory.held);
      const alpha = Math.min(255, Math.floor((game.heldItemTime * 256) / 10));
      if (alpha > 0) {
        let y = h - 59; if (!survival) y += 14;
        const tw = g.textWidth(name);
        g.fill(cx - tw / 2 - 2, y - 2, cx + tw / 2 + 2, y + 9 + 2, ((Math.floor(alpha * 0) & 255) << 24) >>> 0);
        g.text(name, (w - tw) / 2, y, ((alpha << 24) | 0xffffff) >>> 0);
      }
    }
    this.renderChat(false);
    this.renderDebug();
  }

  itemName(s: ItemStack): string {
    const it = this.game.items;
    const n = it.comp(s.id, 'item_name');
    const name = n?.translate ? tr(n.translate) : it.name(s.id);
    const rarity = it.comp(s.id, 'rarity');
    const col = rarity === 'uncommon' ? '§e' : rarity === 'rare' ? '§b' : rarity === 'epic' ? '§d' : '';
    return col + name;
  }

  /** item icons + count / durability decorations (GuiGraphics.renderItemDecorations) */
  renderItems(items: [ItemStack, number, number][]): void {
    const g = this.g;
    g.flush();
    for (const [s, x, y] of items) this.game.itemRenderer.drawGui(this.game.items.name(s.id), x, y, g.width, g.height);
    for (const [s, x, y] of items) {
      const max = this.game.items.maxDamage(s.id);
      if (max > 0 && (s.damage ?? 0) > 0) {
        const f = 1 - (s.damage ?? 0) / max;
        const bw = Math.round(13 - (s.damage! * 13) / max);
        const hue = Math.max(0, f) / 3;
        const col = hsvToRgb(hue, 1, 1);
        g.fill(x + 2, y + 13, x + 2 + 13, y + 13 + 2, 0xff000000);
        g.fill(x + 2, y + 13, x + 2 + bw, y + 13 + 1, (0xff000000 | col) >>> 0);
      }
      if (s.count > 1) { const t = String(s.count); g.text(t, x + 19 - 2 - g.textWidth(t), y + 6 + 3, 0xffffffff); }
    }
  }

  private renderXp(cx: number, h: number): void {
    const g = this.g, p = this.game.player;
    const x = cx - 91;
    g.sprite('hud/experience_bar_background', x, h - 32 + 3, 182, 5);
    const prog = Math.floor(p.xpProgress * 183);
    if (prog > 0) g.spritePart('hud/experience_bar_progress', x, h - 32 + 3, prog, 5);
    if (p.xpLevel > 0) {
      const s = String(p.xpLevel), tx = (g.width - g.textWidth(s)) / 2, ty = h - 31 - 4;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) g.text(s, tx + ox, ty + oy, 0xff000000, false);
      g.text(s, tx, ty, 0xff80ff20, false);
    }
  }

  private renderHealthFood(cx: number, h: number): void {
    const g = this.g, game = this.game, p = game.player;
    const t = game.tickNo;
    const health = Math.ceil(p.health);
    if (health < this.lastHealth && p.invulnerableTime > 0) { this.lastHealthTime = t; this.healthBlinkUntil = t + 20; }
    else if (health > this.lastHealth && p.invulnerableTime > 0) { this.lastHealthTime = t; this.healthBlinkUntil = t + 10; }
    if (t - this.lastHealthTime > 20) { this.displayHealth = health; this.lastHealthTime = t; }
    this.lastHealth = health;
    const blink = this.healthBlinkUntil > t && ((this.healthBlinkUntil - t) / 3) % 2 === 1;
    const left = cx - 91, right = cx + 91;
    const yBase = h - 39;
    const maxH = Math.max(p.maxHealth, Math.max(this.displayHealth, health));
    const rows = Math.ceil((maxH + Math.ceil(p.absorption)) / 2 / 10);
    const rowH = Math.max(10 - (rows - 2), 3);
    // armour above the hearts
    const armor = this.armorValue();
    const armorY = yBase - (rows - 1) * rowH - 10;
    if (armor > 0) for (let i = 0; i < 10; i++) {
      const x = left + i * 8;
      g.sprite(i * 2 + 1 < armor ? 'hud/armor_full' : i * 2 + 1 === armor ? 'hud/armor_half' : 'hud/armor_empty', x, armorY, 9, 9);
    }
    // hearts (Gui.renderHearts)
    const hc = game.hardcore ? '_hardcore' : '';
    const regen = -1;
    for (let i = Math.ceil(maxH / 2) - 1; i >= 0; i--) {
      const row = Math.floor(i / 10), col = i % 10;
      const x = left + col * 8;
      let y = yBase - row * rowH;
      if (health <= 4) y += Math.floor(this.rand() * 2);
      if (i === regen) y -= 2;
      g.sprite('hud/heart/container' + (game.hardcore ? '_hardcore' : '') + (blink ? '_blinking' : ''), x, y, 9, 9);
      const hv = i * 2;
      if (blink && hv < this.displayHealth) g.sprite(`hud/heart/${hc ? 'hardcore_' : ''}${hv + 1 === this.displayHealth ? 'half' : 'full'}_blinking`, x, y, 9, 9);
      if (hv < health) g.sprite(`hud/heart/${hc ? 'hardcore_' : ''}${hv + 1 === health ? 'half' : 'full'}`, x, y, 9, 9);
    }
    // food (Gui.renderFood)
    for (let i = 0; i < 10; i++) {
      let y = yBase;
      if (p.saturation <= 0 && t % (p.food * 3 + 1) === 0) y += Math.floor(this.rand() * 3) - 1;
      const x = right - i * 8 - 9;
      g.sprite('hud/food_empty', x, y, 9, 9);
      if (i * 2 + 1 < p.food) g.sprite('hud/food_full', x, y, 9, 9);
      else if (i * 2 + 1 === p.food) g.sprite('hud/food_half', x, y, 9, 9);
    }
    // air (Gui.renderAirBubbles)
    if (p.eyeInWater || p.air < p.maxAir) {
      const y = yBase - 10;
      const full = Math.ceil(((p.air - 2) * 10) / p.maxAir), part = Math.ceil((p.air * 10) / p.maxAir) - full;
      for (let i = 0; i < full + part; i++) g.sprite(i < full ? 'hud/air' : 'hud/air_bursting', right - i * 8 - 9, y, 9, 9);
    }
  }
  private armorValue(): number {
    let a = 0;
    for (let i = 36; i < 40; i++) {
      const s = this.game.player.inventory.slots[i];
      if (!s) continue;
      for (const m of this.game.items.comp(s.id, 'attribute_modifiers') ?? []) if (String(m.type).endsWith('armor')) a += m.amount;
    }
    return Math.round(a);
  }

  /** DebugScreenOverlay (F3) — left column game info, right column system info. */
  renderDebug(): void {
    if (!this.debug) return;
    const g = this.g, game = this.game, p = game.player;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    const yaw = ((p.yaw % 360) + 360) % 360;
    const facing = ['south', 'west', 'north', 'east'][Math.floor((yaw + 45) / 90) % 4];
    const towards = { south: 'Towards positive Z', west: 'Towards negative X', north: 'Towards negative Z', east: 'Towards positive X' }[facing];
    const w = game.client.world;
    const biome = game.biomes.list[w.biome(bx, by, bz)]?.name ?? '?';
    const sky = w.sky(bx, by, bz), bl = w.blockLight(bx, by, bz);
    const left = [
      'Minecraft 26.3 (26.3/vanilla)',
      `${this.fps} fps T: ${game.settings.renderDistance > 0 ? 'inf' : ''} vsync`,
      `C: ${game.wr.sectionsDrawn}/${game.wr.terrain.sections.size} D: ${game.settings.renderDistance}, pC: ${game.client.pending}`,
      `E: ${game.entities.length}/${game.entities.length}`,
      '',
      `XYZ: ${p.x.toFixed(3)} / ${p.y.toFixed(5)} / ${p.z.toFixed(3)}`,
      `Block: ${bx} ${by} ${bz} [${bx & 15} ${by & 15} ${bz & 15}]`,
      `Chunk: ${bx >> 4} ${by >> 4} ${bz >> 4} [${(bx >> 4) & 31} ${(bz >> 4) & 31} in r.${bx >> 9}.${bz >> 9}.mca]`,
      `Facing: ${facing} (${towards}) (${(((p.yaw + 180) % 360) - 180).toFixed(1)} / ${p.pitch.toFixed(1)})`,
      `Client Light: ${Math.max(sky, bl)} (${sky} sky, ${bl} block)`,
      `Biome: minecraft:${biome}`,
      `Local Difficulty: ?? // ?? (Day ${Math.floor(game.dayTime / 24000)})`,
      `Day ${Math.floor(game.dayTime / 24000)}, Time ${game.dayTime % 24000}`,
    ];
    const mem = (performance as any).memory;
    const right = [
      'JavaScript (WebGL2)',
      mem ? `Mem: ${Math.round((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100)}% ${Math.round(mem.usedJSHeapSize / 1048576)}/${Math.round(mem.jsHeapSizeLimit / 1048576)}MB` : 'Mem: n/a',
      `CPU: ${navigator.hardwareConcurrency}x`,
      '',
      `Display: ${g.gl.drawingBufferWidth}x${g.gl.drawingBufferHeight}`,
      String(g.gl.getParameter(g.gl.VERSION)),
    ];
    if (game.hit) {
      const st = game.hit.state; const props = game.reg.props(st);
      right.push('', `§nTargeted Block: ${game.hit.x}, ${game.hit.y}, ${game.hit.z}`, 'minecraft:' + game.reg.name(st));
      for (const [k, v] of Object.entries(props)) right.push(`${k}: ${v === 'true' ? '§a' : v === 'false' ? '§c' : ''}${v}`);
    }
    left.forEach((l, i) => { if (!l) return; const tw = g.textWidth(l); g.fill(1, 2 + i * 9 - 1, 2 + tw + 1, 2 + i * 9 + 8, 0x90505050); g.text(l, 2, 2 + i * 9, 0xffe0e0e0, false); });
    right.forEach((l, i) => { if (!l) return; const tw = g.textWidth(l); const x = g.width - 2 - tw; g.fill(x - 1, 2 + i * 9 - 1, x + tw + 1, 2 + i * 9 + 8, 0x90505050); g.text(l, x, 2 + i * 9, 0xffe0e0e0, false); });
    void MIN_Y;
  }
}

function hsvToRgb(h: number, s: number, v: number): number {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}
