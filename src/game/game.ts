// In-game state and loop: player, block interaction, item entities, time, world streaming, rendering.
// Runs at vanilla's 20 ticks per second with interpolated rendering (partial ticks).
import type { Bundle } from '../assets/bundle';
import { WorldClient } from '../world/client';
import { WorldRenderer, type Camera } from '../render/worldrenderer';
import { Overlays } from '../render/overlays';
import { ItemRenderer, ITEM_LIGHT0, ITEM_LIGHT1 } from '../render/items';
import { BlockRegistry } from '../world/registry';
import { BlockInfo } from '../world/blockinfo';
import { Biomes } from '../world/biomes';
import { Tags } from '../worldgen/features';
import { BlockProps } from './blockprops';
import { ItemRegistry, type ItemStack } from './items';
import { LootTables } from './loot';
import { PhysicsWorld, Entity } from './entity';
import { Player, type GameMode, type Difficulty, type Input } from './player';
import { Placement } from './placement';
import { raycast, FACE_VEC, type Hit } from './raycast';
import { mul, rotX, rotZ, translate, rotY, scale } from '../util/mat';
import type { StaticData, WorldConfig } from '../worker/protocol';
import { GEN } from '../assets/bundle';

export interface GameSettings {
  renderDistance: number; fov: number; gamma: number; clouds: 'off' | 'fast' | 'fancy'; viewBobbing: boolean;
  smoothLighting: boolean; biomeBlend: number; mouseSensitivity: number; invertY: boolean;
}

export class ItemEntity extends Entity {
  age = 0; pickupDelay = 10; bobOffs = Math.random() * Math.PI * 2;
  constructor(phys: PhysicsWorld, public stack: ItemStack) { super(phys); this.width = 0.25; this.height = 0.25; this.stepHeight = 0; }
  tick(): void {
    this.xo = this.x; this.yo = this.y; this.zo = this.z;
    this.age++;
    if (this.pickupDelay > 0) this.pickupDelay--;
    this.updateFluids(0.2);
    if (this.inWater) { this.vy += this.vy < 0.06 ? 5.0e-4 : 0; this.vx *= 0.99; this.vz *= 0.99; }
    else this.vy -= 0.04;
    this.move(this.vx, this.vy, this.vz);
    let f = 0.98;
    if (this.onGround) f = this.blockBelowFriction() * 0.98;
    this.vx *= f; this.vy *= 0.98; this.vz *= f;
    if (this.onGround && this.vy < 0) this.vy *= -0.5;
    if (this.age >= 6000) this.removed = true;
  }
}

export class Game {
  readonly reg: BlockRegistry; readonly info: BlockInfo; readonly biomes: Biomes; readonly tags: Tags;
  readonly props: BlockProps; readonly items: ItemRegistry; readonly loot: LootTables; readonly placement: Placement;
  readonly client: WorldClient; readonly wr: WorldRenderer; readonly overlays: Overlays; readonly itemRenderer: ItemRenderer;
  readonly phys: PhysicsWorld; readonly player: Player;
  readonly entities: ItemEntity[] = [];
  gameTime = 0; dayTime = 6000; tickNo = 0;
  partial = 0;
  hit: Hit | null = null;
  breaking: { x: number; y: number; z: number; progress: number; state: number } | null = null;
  destroyDelay = 0; useDelay = 0; useTicks = 0;
  input: Input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
  attackHeld = false; useHeld = false;
  paused = false;
  heldItemName = ''; heldItemTime = 0;
  swingTime = 0; swingO = 0; swinging = false;
  gameRules: Record<string, boolean | number> = { doDaylightCycle: true, keepInventory: false, naturalRegeneration: true, doMobSpawning: true, doTileDrops: true, fallDamage: true };
  hardcore = false;
  pendingBonusChest = false;
  /** block entity inventories keyed "x,y,z": chests (27), furnaces (3 + progress) */
  readonly containers = new Map<string, { kind: string; items: (ItemStack | null)[]; burn: number; burnMax: number; cook: number; cookMax: number }>();
  onOpenScreen: (kind: string, data: any) => void = () => {};
  recipes: any = null;
  private lastView = 0;
  onDeath: (msg: string) => void = () => {};
  onSound: (name: string, x: number, y: number, z: number, vol?: number, pitch?: number) => void = () => {};

  constructor(readonly gl: WebGL2RenderingContext, readonly b: Bundle, readonly settings: GameSettings, cloudsTex: any, endSky: any) {
    this.reg = new BlockRegistry(b.blocks);
    this.info = new BlockInfo(this.reg, b.models, b.blocks);
    this.biomes = new Biomes(b.worldgen, b.grassColormap, b.foliageColormap, b.dryFoliageColormap);
    this.tags = new Tags(b.tags, this.reg);
    this.props = new BlockProps(this.reg, this.info, this.tags);
    this.items = new ItemRegistry(b.registries.item, b.items.components, this.reg, this.tags);
    (this.items as any).tags = this.tags;
    this.loot = new LootTables(b.lootTables, this.items, this.reg);
    this.placement = new Placement(this.reg, this.info, this.tags);
    this.wr = new WorldRenderer(gl, b, cloudsTex, this.biomes);
    this.wr.endSky = endSky;
    this.overlays = new Overlays(gl);
    this.itemRenderer = new ItemRenderer(gl, b.models, b.items.definitions, this.wr.textures, b.itemAtlas, b.itemAtlasImage);
    this.itemRenderer.itemImage = b.itemAtlasImage;
    this.client = new WorldClient(this.wr.terrain);
    this.phys = new PhysicsWorld(this.client.world, this.props, this.reg);
    this.player = new Player(this.phys);
    this.player.onDeath = (src) => this.onDeath(deathMessage(src));
    this.player.onDamage = () => this.onSound('entity.player.hurt', this.player.x, this.player.y, this.player.z);
  }

  async start(config: WorldConfig, worldId: string, mode: GameMode, difficulty: Difficulty): Promise<void> {
    const spriteNames = [...this.b.models.sprites, 'block/water_still', 'block/water_flow', 'block/water_overlay', 'block/lava_still', 'block/lava_flow'];
    const data: StaticData = {
      blocks: this.b.blocks, models: this.b.models, worldgen: this.b.worldgen, tags: this.b.tags,
      grass: this.b.grassColormap, foliage: this.b.foliageColormap, dryFoliage: this.b.dryFoliageColormap,
      spriteSlots: this.wr.textures.slotTable(spriteNames), spriteNames, structureBase: GEN + 'data/structure/',
    };
    this.wr.setDimension(config.dimension ?? 'overworld');
    await this.client.init(data, config, worldId, this.settings.smoothLighting, this.settings.biomeBlend);
    const sp = this.client.spawn!;
    this.player.gameMode = mode; this.player.difficulty = difficulty;
    this.player.setPos(sp[0], sp[1], sp[2]);
    this.client.setView(sp[0], sp[1], sp[2], this.settings.renderDistance);
  }

  /** Spawn chunk ready: the chunk under the player is meshed and lit. */
  spawnReady(): boolean {
    const p = this.player;
    return !!this.client.world.getChunk(Math.floor(p.x) >> 4, Math.floor(p.z) >> 4) && this.client.loaded >= 9;
  }

  reach(): number { return this.player.gameMode === 'creative' ? 5 : 4.5; }

  look(): [number, number, number] {
    const yr = (this.player.yaw * Math.PI) / 180, pr = (this.player.pitch * Math.PI) / 180;
    return [-Math.sin(yr) * Math.cos(pr), -Math.sin(pr), Math.cos(yr) * Math.cos(pr)];
  }

  tick(): void {
    if (this.paused) return;
    this.tickNo++; this.gameTime++;
    if (this.gameRules.doDaylightCycle) this.dayTime++;
    this.wr.tick();
    const p = this.player;
    p.naturalRegeneration = !!this.gameRules.naturalRegeneration;
    p.keepInventory = !!this.gameRules.keepInventory;
    p.tick(this.input, this.tickNo);
    // block targeting
    const [dx, dy, dz] = this.look();
    this.hit = p.dead || p.gameMode === 'spectator' ? null : raycast(this.client.world, this.props, p.x, p.y + p.eyeHeight, p.z, dx, dy, dz, this.reach());
    if (this.pendingBonusChest && this.spawnReady() && this.client.world.getChunk(Math.floor(p.x) >> 4, Math.floor(p.z) >> 4)) { this.pendingBonusChest = false; this.placeBonusChest(); }
    this.tickFurnaces();
    this.tickBreaking();
    this.tickUse();
    // swing animation (LivingEntity.updateSwingTime, 6 ticks)
    this.swingO = this.swingTime;
    if (this.swinging) { this.swingTime++; if (this.swingTime >= 6) { this.swingTime = 0; this.swinging = false; } } else this.swingTime = 0;
    // item entities
    for (const e of this.entities) {
      e.tick();
      if (!e.removed && e.pickupDelay === 0 && !p.dead) {
        const d = (e.x - p.x) ** 2 + (e.y - (p.y + 0.9)) ** 2 + (e.z - p.z) ** 2;
        if (d < 1.5 * 1.5 && this.addToInventory(e.stack)) {
          if (e.stack.count <= 0) e.removed = true;
          this.onSound('entity.item.pickup', e.x, e.y, e.z, 0.2, ((Math.random() - Math.random()) * 0.7 + 1) * 2);
        }
      }
    }
    for (let i = this.entities.length - 1; i >= 0; i--) if (this.entities[i].removed) this.entities.splice(i, 1);
    if (this.heldItemTime > 0) this.heldItemTime--;
    if (this.tickNo - this.lastView >= 10) { this.client.setView(p.x, p.y, p.z, this.settings.renderDistance); this.lastView = this.tickNo; }
  }

  // ---------------------------------------------------------------- breaking
  private tickBreaking(): void {
    const p = this.player;
    if (this.destroyDelay > 0) { this.destroyDelay--; }
    if (!this.attackHeld || !this.hit || p.gameMode === 'adventure' || p.gameMode === 'spectator') { this.breaking = null; return; }
    const h = this.hit;
    if (p.gameMode === 'creative') {
      if (this.destroyDelay > 0) return;
      this.swing();
      this.destroyBlock(h.x, h.y, h.z, false);
      this.destroyDelay = 5;
      return;
    }
    if (!this.breaking || this.breaking.x !== h.x || this.breaking.y !== h.y || this.breaking.z !== h.z || this.breaking.state !== h.state) {
      this.breaking = { x: h.x, y: h.y, z: h.z, progress: 0, state: h.state };
    }
    this.swing();
    const progress = this.destroyProgress(h.state);
    if (this.breaking.progress === 0 && this.tickNo % 4 === 0) this.blockSound(h.state, 'hit', h.x, h.y, h.z);
    this.breaking.progress += progress;
    if (this.tickNo % 4 === 0) this.blockSound(h.state, 'hit', h.x, h.y, h.z, 0.25, 0.5);
    if (this.breaking.progress >= 1) {
      this.destroyBlock(h.x, h.y, h.z, true);
      this.breaking = null;
      this.destroyDelay = 5;
    }
  }

  /** BlockState.getDestroyProgress with Player.getDestroySpeed */
  destroyProgress(state: number): number {
    const p = this.player;
    const hardness = this.props.hardness[this.reg.stateBlock[state]];
    if (hardness < 0) return 0;
    if (hardness === 0) return 1;
    const held = p.inventory.held;
    const rule = this.items.toolRule(held ? held.id : null, state);
    let speed = rule.speed;
    const eff = held ? this.enchantLevel(held, 'minecraft:efficiency') : 0;
    if (speed > 1 && eff > 0) speed += eff * eff + 1;
    if (p.eyeInWater) speed *= 0.2;
    if (!p.onGround) speed /= 5;
    const correct = this.correctTool(held, state);
    return speed / hardness / (correct ? 30 : 100);
  }

  requiresTool(state: number): boolean {
    const bi = this.reg.stateBlock[state]; const name = this.reg.blocks[bi].name;
    if (/^(ice|packed_ice|blue_ice|frosted_ice|glass.*|.*_glass.*|glowstone)$/.test(name)) return false;
    return this.tags.block('mineable/pickaxe').has(bi) || /^(snow|snow_block|cobweb)$/.test(name);
  }
  correctTool(held: ItemStack | null, state: number): boolean {
    if (!this.requiresTool(state)) return true;
    return this.items.toolRule(held ? held.id : null, state).correct === true;
  }
  enchantLevel(stack: ItemStack | null | undefined, ench: string): number {
    return stack?.components?.['minecraft:enchantments']?.[ench.startsWith('minecraft:') ? ench : 'minecraft:' + ench] ?? 0;
  }

  destroyBlock(x: number, y: number, z: number, drops: boolean): void {
    const w = this.client.world;
    const s = w.getState(x, y, z);
    if (s === 0) return;
    const name = this.reg.name(s);
    // two-block structures (doors, beds, tall plants) break both halves
    const half = this.reg.prop(s, 'half');
    const others: [number, number, number][] = [];
    if (half === 'lower' && this.reg.name(w.getState(x, y + 1, z)) === name) others.push([x, y + 1, z]);
    if (half === 'upper' && this.reg.name(w.getState(x, y - 1, z)) === name) others.push([x, y - 1, z]);
    const waterlogged = this.reg.prop(s, 'waterlogged') === 'true';
    this.blockSound(s, 'break', x, y, z);
    this.setBlock(x, y, z, waterlogged ? this.reg.state('water', { level: 0 }) : 0);
    for (const o of others) this.setBlock(o[0], o[1], o[2], 0);
    const p = this.player;
    if (drops && p.gameMode === 'survival' && this.gameRules.doTileDrops) {
      p.causeExhaustion(0.005);
      const held = p.inventory.held;
      if (this.correctTool(held, s)) {
        const stacks = this.loot.roll('blocks/' + (half === 'upper' ? name : name), {
          rng: Math.random, tool: held, state: s, enchantLevel: (st, e) => this.enchantLevel(st, e),
        });
        for (const st of stacks) this.spawnItem(x + 0.5, y + 0.5, z + 0.5, st);
        const xp = oreXp(name);
        if (xp && !this.enchantLevel(held, 'minecraft:silk_touch')) { p.giveXp(xp); this.onSound('entity.experience_orb.pickup', p.x, p.y, p.z, 0.1, 0.5 + Math.random()); }
      }
      if (held && this.items.maxDamage(held.id) > 0 && this.props.hardness[this.reg.stateBlock[s]] !== 0) this.damageItem(held, 1);
    }
  }

  damageItem(stack: ItemStack, n: number): void {
    stack.damage = (stack.damage ?? 0) + n;
    if (stack.damage >= this.items.maxDamage(stack.id)) {
      stack.count = 0;
      this.player.inventory.held = null;
      this.onSound('entity.item.break', this.player.x, this.player.y, this.player.z, 0.8, 0.8 + Math.random() * 0.4);
    }
  }

  /** Set a block, propagate neighbour shape updates, and unsupported plants/torches pop off. */
  setBlock(x: number, y: number, z: number, s: number): void {
    this.client.setBlock(x, y, z, s);
    const w = this.client.world;
    for (const [nx, ny, nz, ns] of this.placement.neighbourUpdates(w, x, y, z)) this.client.setBlock(nx, ny, nz, ns);
    // BlockBehaviour.canSurvive checks for the block above (plants, torches, carpets, rails...)
    const above = w.getState(x, y + 1, z);
    if (above && s === 0 && this.needsSupport(above)) {
      if (this.player.gameMode === 'survival') for (const st of this.loot.roll('blocks/' + this.reg.name(above), { rng: Math.random, state: above })) this.spawnItem(x + 0.5, y + 1.5, z + 0.5, st);
      this.setBlock(x, y + 1, z, 0);
    }
  }
  private needsSupport(s: number): boolean {
    const n = this.reg.name(s);
    return this.props.noCollision[this.reg.stateBlock[s]] === 1 && !/^(water|lava|air|cave_air|void_air|fire|soul_fire|cobweb|vine|light|.*_wall_.*|wall_torch|ladder)$/.test(n) || /_carpet$|^(snow|cactus|sugar_cane|bamboo|.*_door)$/.test(n);
  }

  spawnItem(x: number, y: number, z: number, stack: ItemStack, fromPlayer = false): void {
    const e = new ItemEntity(this.phys, stack);
    e.setPos(x, y - 0.125, z);
    if (fromPlayer) {
      const [dx, dy, dz] = this.look();
      e.vx = dx * 0.3; e.vy = dy * 0.3 + 0.1; e.vz = dz * 0.3;
      e.pickupDelay = 40;
    } else {
      e.vx = Math.random() * 0.2 - 0.1; e.vy = 0.2; e.vz = Math.random() * 0.2 - 0.1;
    }
    this.entities.push(e);
  }

  /** Inventory.add: fill matching stacks in hotbar/main, then empty slots. */
  addToInventory(stack: ItemStack): boolean {
    const inv = this.player.inventory.slots;
    const max = this.items.maxStack(stack.id);
    let changed = false;
    const order = [this.player.inventory.selected, ...Array.from({ length: 36 }, (_, i) => i)];
    for (const i of order) {
      const s = inv[i];
      if (s && s.id === stack.id && !s.damage && !stack.damage && s.count < max) {
        const n = Math.min(max - s.count, stack.count); s.count += n; stack.count -= n; changed = true;
        if (stack.count <= 0) return true;
      }
    }
    for (const i of order) if (!inv[i]) { inv[i] = { ...stack }; stack.count = 0; return true; }
    return changed;
  }

  // ---------------------------------------------------------------- use / place
  private tickUse(): void {
    if (this.useDelay > 0) this.useDelay--;
    const p = this.player;
    const held = p.inventory.held;
    if (!this.useHeld) { this.useTicks = 0; return; }
    const food = held ? this.items.comp(held.id, 'food') : null;
    if (held && food && (p.food < 20 || this.items.comp(held.id, 'consumable')?.can_always_eat || p.creative)) {
      this.useTicks++;
      if (this.useTicks % 4 === 0) this.onSound('entity.generic.eat', p.x, p.y, p.z, 0.5, 1 + (Math.random() - Math.random()) * 0.4);
      const dur = Math.round((this.items.comp(held.id, 'consumable')?.consume_seconds ?? 1.6) * 20);
      if (this.useTicks >= dur) {
        p.eat(food.nutrition, food.saturation / Math.max(1, food.nutrition) / 2);
        this.onSound('entity.player.burp', p.x, p.y, p.z, 0.5, Math.random() * 0.1 + 0.9);
        if (!p.creative) { held.count--; if (held.count <= 0) p.inventory.held = null; }
        this.useTicks = 0;
      }
      return;
    }
    if (this.useDelay > 0) return;
    this.useDelay = 4;
    this.useItemOn();
  }

  useItemOn(): void {
    const p = this.player, h = this.hit;
    if (!h || p.gameMode === 'spectator') return;
    const w = this.client.world;
    const held = p.inventory.held;
    // block interactions (doors, trapdoors, fence gates, levers, buttons) unless sneaking with an item
    const target = w.getState(h.x, h.y, h.z);
    const tname = this.reg.name(target);
    if (!(p.sneaking && held)) {
      const key = `${h.x},${h.y},${h.z}`;
      if (tname === 'crafting_table') { this.onOpenScreen('crafting', null); this.swing(); return; }
      if (tname === 'chest' || tname === 'trapped_chest' || tname === 'barrel' || tname === 'ender_chest') {
        if (tname.endsWith('chest') && this.info.solidRender[w.getState(h.x, h.y + 1, h.z)]) return;
        this.onOpenScreen('chest', this.container(key, 'chest'));
        this.onSound(tname === 'barrel' ? 'block.barrel.open' : tname === 'ender_chest' ? 'block.ender_chest.open' : 'block.chest.open', h.x, h.y, h.z, 0.5, Math.random() * 0.1 + 0.9);
        this.swing(); return;
      }
      if (tname === 'furnace' || tname === 'smoker' || tname === 'blast_furnace') { this.onOpenScreen('furnace', this.container(key, 'furnace')); this.swing(); return; }
      if ((/_door$|_trapdoor$|_fence_gate$/.test(tname) && !/^iron_/.test(tname)) || tname === 'lever') {
        const open = this.reg.hasProp(target, 'open') ? 'open' : 'powered';
        const nv = this.reg.prop(target, open) === 'true' ? 'false' : 'true';
        this.client.setBlock(h.x, h.y, h.z, this.reg.withProp(target, open, nv));
        if (/_door$/.test(tname)) {
          const oy = this.reg.prop(target, 'half') === 'lower' ? 1 : -1;
          const other = w.getState(h.x, h.y + oy, h.z);
          if (this.reg.name(other) === tname) this.client.setBlock(h.x, h.y + oy, h.z, this.reg.withProp(other, 'open', nv));
        }
        const kind = tname.endsWith('_trapdoor') ? 'trapdoor' : tname.endsWith('_fence_gate') ? 'fence_gate' : tname.endsWith('_door') ? 'door' : 'lever';
        this.onSound(kind === 'lever' ? 'block.lever.click' : `block.${materialOf(tname)}_${kind}.${nv === 'true' ? 'open' : 'close'}`, h.x, h.y, h.z);
        this.swing();
        return;
      }
    }
    if (!held) return;
    const base = this.items.blockOf[held.id];
    if (base < 0) return;
    let px = h.x, py = h.y, pz = h.z;
    const existing = this.reg.name(target) === this.reg.name(base) && this.reg.name(base).endsWith('_slab');
    if (!this.placement.replaceable(target) && !(existing && this.reg.prop(target, 'type') !== 'double' && (h.face === (this.reg.prop(target, 'type') === 'bottom' ? 1 : 0)))) {
      const v = FACE_VEC[h.face]; px += v[0]; py += v[1]; pz += v[2];
      const cur = w.getState(px, py, pz);
      const sameSlab = this.reg.name(cur) === this.reg.name(base) && this.reg.name(base).endsWith('_slab') && this.reg.prop(cur, 'type') !== 'double';
      if (!this.placement.replaceable(cur) && !sameSlab) return;
    }
    const states = this.placement.forPlacement(base, w, { face: h.face, hx: h.hx, hy: h.hy, hz: h.hz, x: px, y: py, z: pz, yaw: p.yaw, pitch: p.pitch, sneaking: p.sneaking });
    if (!states) return;
    // can't place into the player
    const pb = p.box;
    for (const [x, y, z, s] of states) for (const c of this.props.collision(s)) {
      if (x + c[3] > pb.x0 && x + c[0] < pb.x1 && y + c[4] > pb.y0 && y + c[1] < pb.y1 && z + c[5] > pb.z0 && z + c[2] < pb.z1) return;
    }
    for (const [x, y, z, s] of states) this.setBlock(x, y, z, s);
    this.blockSound(states[0][3], 'place', px, py, pz);
    this.swing();
    if (!p.creative) { held.count--; if (held.count <= 0) p.inventory.held = null; }
  }

  container(key: string, kind: string) {
    let c = this.containers.get(key);
    if (!c) { c = { kind, items: new Array(kind === 'chest' ? 27 : 3).fill(null), burn: 0, burnMax: 0, cook: 0, cookMax: 200 }; this.containers.set(key, c); }
    return c;
  }

  /** AbstractFurnaceBlockEntity.serverTick for every furnace with contents. */
  private tickFurnaces(): void {
    if (!this.recipes) return;
    for (const [key, f] of this.containers) {
      if (f.kind !== 'furnace') continue;
      const [x, y, z] = key.split(',').map(Number);
      const st = this.client.world.getState(x, y, z);
      if (!/furnace|smoker/.test(this.reg.name(st))) { continue; }
      const input = f.items[0], fuel = f.items[1], out = f.items[2];
      const recipe = input ? this.recipes.smelting.get(input.id) : null;
      const canCook = recipe && (!out || (out.id === recipe.out.id && out.count + recipe.out.count <= this.items.maxStack(out.id)));
      const wasLit = f.burn > 0;
      if (f.burn > 0) f.burn--;
      if (f.burn <= 0 && canCook && fuel) {
        const bt = fuelTime(this.items.name(fuel.id), this.items.comp(fuel.id, 'cooking_fuel'));
        if (bt > 0) { f.burn = f.burnMax = bt; fuel.count--; if (fuel.count <= 0) f.items[1] = this.items.name(fuel.id) === 'lava_bucket' ? { id: this.items.id('bucket'), count: 1 } : null; }
      }
      if (f.burn > 0 && canCook) {
        f.cookMax = recipe.time;
        if (++f.cook >= f.cookMax) {
          f.cook = 0;
          f.items[2] = out ? { ...out, count: out.count + recipe.out.count } : { ...recipe.out };
          input!.count--; if (input!.count <= 0) f.items[0] = null;
        }
      } else if (f.cook > 0) f.cook = Math.max(0, f.cook - 2);
      const lit = f.burn > 0;
      if (lit !== wasLit && this.reg.hasProp(st, 'lit')) this.client.setBlock(x, y, z, this.reg.withProp(st, 'lit', lit ? 'true' : 'false'));
    }
  }

  /** BonusChestFeature: chest + 4 torches near spawn, contents from loot table chests/spawn_bonus_chest. */
  private placeBonusChest(): void {
    const p = this.player; const w = this.client.world;
    for (let tries = 0; tries < 64; tries++) {
      const x = Math.floor(p.x) + Math.floor(Math.random() * 8) - 4, z = Math.floor(p.z) + Math.floor(Math.random() * 8) - 4;
      let y = 319; while (y > -64 && (w.getState(x, y, z) === 0 || this.props.replaceable.has(this.reg.stateBlock[w.getState(x, y, z)]))) y--;
      y++;
      if (!this.info.solidRender[w.getState(x, y - 1, z)]) continue;
      this.setBlock(x, y, z, this.reg.defaultState('chest'));
      const c = this.container(`${x},${y},${z}`, 'chest');
      const loot = this.loot.roll('chests/spawn_bonus_chest', { rng: Math.random });
      loot.forEach((s, i) => { let k = Math.floor(Math.random() * 27); for (let j = 0; j < 27 && c.items[k]; j++) k = (k + 1) % 27; c.items[k] = s; void i; });
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (w.getState(x + dx, y, z + dz) === 0 && this.info.solidRender[w.getState(x + dx, y - 1, z + dz)]) this.setBlock(x + dx, y, z + dz, this.reg.defaultState('torch'));
      return;
    }
  }

  pickBlock(): void {
    const h = this.hit; if (!h || this.player.gameMode !== 'creative') return;
    const it = this.items.itemOfBlock[this.reg.stateBlock[h.state]];
    if (it < 0) return;
    const inv = this.player.inventory;
    for (let i = 0; i < 9; i++) if (inv.slots[i]?.id === it) { inv.selected = i; return; }
    inv.held = { id: it, count: 1 };
  }

  dropHeld(all: boolean): void {
    const inv = this.player.inventory; const h = inv.held;
    if (!h) return;
    const n = all ? h.count : 1;
    this.spawnItem(this.player.x, this.player.y + this.player.eyeHeight - 0.3, this.player.z, { ...h, count: n }, true);
    h.count -= n; if (h.count <= 0) inv.held = null;
    this.swing();
  }

  swing(): void { if (!this.swinging || this.swingTime >= 3) { this.swingTime = -1; this.swinging = true; } }

  selectSlot(i: number): void {
    const inv = this.player.inventory;
    inv.selected = ((i % 9) + 9) % 9;
    const h = inv.held;
    this.heldItemName = h ? h.id + '' : '';
    this.heldItemTime = h ? 40 : 0;
  }

  blockSound(state: number, kind: 'break' | 'place' | 'hit' | 'step' | 'fall', x: number, y: number, z: number, vol = 1, pitch = 0.8): void {
    this.onSound(`#block:${this.reg.name(state)}:${kind}`, x + 0.5, y + 0.5, z + 0.5, vol, pitch);
  }

  // ---------------------------------------------------------------- rendering
  camera(partial: number): Camera {
    const p = this.player;
    const lerp = (a: number, b: number) => a + (b - a) * partial;
    const cam: Camera = { x: lerp(p.xo, p.x), y: lerp(p.yo, p.y) + p.eyeHeight, z: lerp(p.zo, p.z), yaw: p.yaw, pitch: p.pitch, fov: this.settings.fov * lerp(p.fovModifierO, p.fovModifier) };
    if (p.eyeInWater) cam.fov *= 6 / 7;
    if (p.dead) { cam.fov *= 1; }
    if (this.settings.viewBobbing) {
      // GameRenderer.bobView
      const f = p.walkDist - p.walkDistO, g = -(p.walkDist + f * partial), h = lerp(p.bobO, p.bob);
      cam.bob = mul(translate(Math.sin(g * Math.PI) * h * 0.5, -Math.abs(Math.cos(g * Math.PI) * h), 0),
        mul(rotZ(Math.sin(g * Math.PI) * h * 3), rotX(Math.abs(Math.cos(g * Math.PI - 0.2) * h) * 5)));
    }
    if (p.hurtTime > 0) {
      // GameRenderer.bobHurt
      const t = (p.hurtTime - partial) / 10;
      const s = Math.sin(t * t * t * t * Math.PI);
      cam.bob = mul(rotZ(-s * 14), cam.bob ?? translate(0, 0, 0));
    }
    return cam;
  }

  render(partial: number, width: number, height: number): void {
    this.partial = partial;
    const cam = this.camera(partial);
    const p = this.player;
    this.wr.underwater = p.eyeInWater;
    const biome = this.client.world.biome(Math.floor(cam.x), Math.floor(cam.y), Math.floor(cam.z));
    this.wr.render(cam, this.dayTime, partial, biome, { renderDistance: this.settings.renderDistance, gamma: this.settings.gamma, clouds: this.settings.clouds }, width, height);
    const ox = -cam.x, oy = -cam.y, oz = -cam.z;
    // item entities
    for (const e of this.entities) {
      const ex = e.xo + (e.x - e.xo) * partial, ey = e.yo + (e.y - e.yo) * partial, ez = e.zo + (e.z - e.zo) * partial;
      if ((ex - cam.x) ** 2 + (ez - cam.z) ** 2 > 64 * 64) continue;
      const age = e.age + partial;
      const bob = Math.sin(age / 10 + e.bobOffs) * 0.1 + 0.1;
      const spin = ((age / 20 + e.bobOffs) * 180) / Math.PI;
      const light = this.lightAt(Math.floor(ex), Math.floor(ey + 0.2), Math.floor(ez));
      const name = this.items.name(e.stack.id);
      const pose = mul(this.wr.view, mul(translate(ex + ox, ey + oy + bob + 0.25 - 0.125, ez + oz), rotY(spin)));
      const n = e.stack.count > 48 ? 5 : e.stack.count > 32 ? 4 : e.stack.count > 16 ? 3 : e.stack.count > 1 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const off = i === 0 ? translate(0, 0, 0) : translate(((i * 7919) % 100) / 100 * 0.15 - 0.075, ((i * 104729) % 100) / 100 * 0.15 - 0.075, ((i * 1299709) % 100) / 100 * 0.15 - 0.075);
        this.itemRenderer.draw(name, 'ground', this.wr.proj, mul(pose, off), light, this.wr.lightmap.tex, this.wr.lastFog, [rotate3(this.wr.view, ITEM_LIGHT0), rotate3(this.wr.view, ITEM_LIGHT1)]);
      }
    }
    // selection outline + crumbling
    if (this.hit && !p.dead) {
      const h = this.hit;
      const boxes = this.props.outline(h.state);
      if (this.breaking) {
        const stage = Math.min(9, Math.floor(this.breaking.progress * 10));
        const slot = this.wr.textures.slotOf.get('block/destroy_stage_' + stage)!;
        this.overlays.crumbling(this.wr.proj, this.wr.view, boxes, h.x, h.y, h.z, h.x + ox, h.y + oy, h.z + oz, this.wr.textures.arrays[0]!, slot & 0xffff);
      }
      this.overlays.outline(this.wr.proj, this.wr.view, boxes, h.x + ox, h.y + oy, h.z + oz, width, height);
    }
    this.renderHand(partial);
  }

  lightAt(x: number, y: number, z: number): [number, number] {
    const w = this.client.world;
    return [Math.max(w.blockLight(x, y, z), this.info.emission[w.getState(x, y, z)]) * 16, w.sky(x, y, z) * 16];
  }

  /** ItemInHandRenderer: held item (or empty hand) with swing arc and bobbing. */
  private renderHand(partial: number): void {
    const p = this.player;
    if (p.gameMode === 'spectator' || p.dead) return;
    const gl = this.gl;
    gl.clear(gl.DEPTH_BUFFER_BIT);
    const held = p.inventory.held;
    if (!held) return;
    const sw = this.swinging ? (this.swingTime + partial) / 6 : 0;
    const sqrtSw = Math.sqrt(Math.max(0, sw));
    // applyItemArmTransform + swing (ItemInHandRenderer.renderArmWithItem)
    const xOff = -0.4 * Math.sin(sqrtSw * Math.PI), yOff = 0.2 * Math.sin(sqrtSw * Math.PI * 2), zOff = -0.2 * Math.sin(sw * Math.PI);
    let m = translate(0.56 + xOff, -0.52 + yOff, -0.72 + zOff);
    const f = Math.sin(sw * sw * Math.PI), g = Math.sin(sqrtSw * Math.PI);
    m = mul(m, mul(rotY(45 + f * -20), mul(rotZ(g * -20), mul(rotX(g * -80), rotY(-45)))));
    const name = this.items.name(held.id);
    const light = this.lightAt(Math.floor(p.x), Math.floor(p.y + p.eyeHeight), Math.floor(p.z));
    this.itemRenderer.draw(name, 'firstperson_righthand', this.wr.proj, mul(this.camBobOnly(partial), m), light, this.wr.lightmap.tex, null, [ITEM_LIGHT0, ITEM_LIGHT1]);
  }
  private camBobOnly(partial: number) { const c = this.camera(partial); return c.bob ?? scale(1, 1, 1); }
}

function rotate3(m: Float32Array, v: number[]): number[] {
  return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];
}

/** Block.popExperience ranges for ores (Blocks.java DropExperienceBlock). */
function oreXp(name: string): number {
  const r = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
  if (/coal_ore$/.test(name)) return r(0, 2);
  if (/(diamond|emerald)_ore$/.test(name)) return r(3, 7);
  if (/lapis_ore$/.test(name) || name === 'nether_quartz_ore') return r(2, 5);
  if (/redstone_ore$/.test(name)) return r(1, 5);
  if (name === 'nether_gold_ore') return r(0, 1);
  if (name === 'spawner') return r(15, 43);
  if (name === 'sculk' || name === 'sculk_catalyst' || name === 'sculk_shrieker' || name === 'sculk_sensor') return name === 'sculk' ? 1 : 5;
  return 0;
}

/** AbstractFurnaceBlockEntity fuel times (ticks); 26.3 marks fuels with the cooking_fuel component. */
function fuelTime(name: string, comp: any): number {
  if (!comp) return 0;
  const t: Record<string, number> = { lava_bucket: 20000, coal_block: 16000, dried_kelp_block: 4001, blaze_rod: 2400, coal: 1600, charcoal: 1600, stick: 100, bamboo: 50, scaffolding: 50 };
  if (name in t) return t[name];
  if (/_planks$|_log$|_wood$|_stem$|_hyphae$|^stripped_|_fence$|_fence_gate$|_stairs$|_trapdoor$|crafting_table|bookshelf|chest|barrel|lectern|jukebox|note_block|composter|loom|smithing_table|cartography_table|fletching_table|daylight_detector|_banner$|_sign$/.test(name)) return /_slab$/.test(name) ? 150 : /_door$|_sign$/.test(name) ? 200 : 300;
  if (/_slab$/.test(name)) return 150;
  if (/_door$|_boat$/.test(name)) return name.endsWith('_boat') ? 1200 : 200;
  if (/_sapling$|_carpet$|bowl|_button$|^stick$/.test(name)) return /_carpet$/.test(name) ? 67 : 100;
  if (/_wool$/.test(name)) return 100;
  return 300;
}

function materialOf(name: string): string {
  const m = name.match(/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped|iron|copper)/);
  if (!m) return 'wooden';
  if (m[1] === 'iron') return 'iron';
  if (m[1] === 'copper') return 'copper';
  if (m[1] === 'cherry' || m[1] === 'bamboo' || m[1] === 'crimson' || m[1] === 'warped') return m[1] === 'crimson' || m[1] === 'warped' ? 'nether_wood' : m[1] + '_wood';
  return 'wooden';
}

export function deathMessage(src: string): string {
  return ({ fall: 'death.attack.fall', drown: 'death.attack.drown', lava: 'death.attack.lava', outOfWorld: 'death.attack.outOfWorld', starve: 'death.attack.starve', mob: 'death.attack.mob' } as Record<string, string>)[src] ?? 'death.attack.generic';
}
