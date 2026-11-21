// Per-state rendering/lighting properties. Shapes and render layers are derived from the baked vanilla
// models; values that vanilla keeps in Java code (light emission, tint providers, same-type culling)
// are tabled here from Blocks.java / BlockColors.java.
import type { BlockRegistry } from './registry';
import type { ModelsJson, BlocksJson } from '../assets/types';
import { bakeChoice, type BakedQuad } from '../mesh/bake';

type Props = Record<string, string>;
const lit = (n: number) => (p: Props) => (p.lit === 'true' ? n : 0);

/** BlockBehaviour.Properties.lightLevel from Blocks.java. */
const EMISSION: Record<string, number | ((p: Props) => number)> = {
  glowstone: 15, sea_lantern: 15, jack_o_lantern: 15, lantern: 15, beacon: 15, conduit: 15,
  end_gateway: 15, end_portal: 15, fire: 15, lava: 15, shroomlight: 15,
  ochre_froglight: 15, verdant_froglight: 15, pearlescent_froglight: 15,
  copper_lantern: 15, exposed_copper_lantern: 15, weathered_copper_lantern: 15, oxidized_copper_lantern: 15,
  waxed_copper_lantern: 15, waxed_exposed_copper_lantern: 15, waxed_weathered_copper_lantern: 15, waxed_oxidized_copper_lantern: 15,
  redstone_lamp: lit(15), campfire: lit(15), soul_campfire: lit(10),
  copper_bulb: lit(15), waxed_copper_bulb: lit(15), exposed_copper_bulb: lit(12), waxed_exposed_copper_bulb: lit(12),
  weathered_copper_bulb: lit(8), waxed_weathered_copper_bulb: lit(8), oxidized_copper_bulb: lit(4), waxed_oxidized_copper_bulb: lit(4),
  end_rod: 14, torch: 14, wall_torch: 14, copper_torch: 14, copper_wall_torch: 14,
  soul_torch: 10, soul_wall_torch: 10, soul_fire: 10, soul_lantern: 10, crying_obsidian: 10,
  nether_portal: 11, magma_block: 3, brewing_stand: 1, brown_mushroom: 1, dragon_egg: 1, end_portal_frame: 1,
  sculk_sensor: 1, calibrated_sculk_sensor: 1, sculk_catalyst: 6, amethyst_cluster: 5, large_amethyst_bud: 4,
  medium_amethyst_bud: 2, small_amethyst_bud: 1, enchanting_table: 7, ender_chest: 7,
  glow_lichen: 7, firefly_bush: 2,
  furnace: lit(13), blast_furnace: lit(13), smoker: lit(13),
  redstone_ore: lit(9), deepslate_redstone_ore: lit(9), redstone_torch: lit(7), redstone_wall_torch: lit(7),
  cave_vines: (p) => (p.berries === 'true' ? 14 : 0), cave_vines_plant: (p) => (p.berries === 'true' ? 14 : 0),
  light: (p) => +p.level,
  respawn_anchor: (p) => [0, 3, 7, 11, 15][+p.charges] ?? 0,
  sea_pickle: (p) => (p.waterlogged === 'true' ? 3 + 3 * +p.pickles : 0),
  candle_cake: lit(3),
  trial_spawner: (p) => (p.trial_spawner_state === 'inactive' || p.trial_spawner_state === 'cooldown' ? 4 : 8),
  vault: (p) => (p.vault_state === 'inactive' ? 6 : 12),
  creaking_heart: (p) => (p.creaking_heart_state === 'awake' ? 15 : 0),
};

/** Translucent-family blocks whose faces against the same block are skipped (HalfTransparentBlock.skipRendering). */
const SAME_TYPE_CULL = /^(glass|tinted_glass|[a-z_]+_stained_glass|ice|packed_ice|blue_ice|slime_block|honey_block|frosted_ice)$/;

export enum Tint { None, Grass, Foliage, Evergreen, Birch, Water, Redstone, Stem, AttachedStem, LilyPad, DryFoliage, GrassSecondary }

const TINTS: Record<string, Tint> = {
  grass_block: Tint.Grass, short_grass: Tint.Grass, tall_grass: Tint.Grass, fern: Tint.Grass, large_fern: Tint.Grass,
  potted_fern: Tint.Grass, sugar_cane: Tint.Grass, bush: Tint.Grass,
  pink_petals: Tint.GrassSecondary, wildflowers: Tint.GrassSecondary,
  oak_leaves: Tint.Foliage, jungle_leaves: Tint.Foliage, acacia_leaves: Tint.Foliage, dark_oak_leaves: Tint.Foliage,
  mangrove_leaves: Tint.Foliage, vine: Tint.Foliage,
  spruce_leaves: Tint.Evergreen, birch_leaves: Tint.Birch,
  water: Tint.Water, bubble_column: Tint.Water, water_cauldron: Tint.Water,
  redstone_wire: Tint.Redstone, melon_stem: Tint.Stem, pumpkin_stem: Tint.Stem,
  attached_melon_stem: Tint.AttachedStem, attached_pumpkin_stem: Tint.AttachedStem,
  lily_pad: Tint.LilyPad, leaf_litter: Tint.DryFoliage,
};

/** BlockBehaviour.OffsetType (Blocks.java .offsetType(...)). 1 = XZ, 2 = XYZ */
const OFFSET_XYZ = /^(short_grass|fern|bush|short_dry_grass|tall_dry_grass|small_dripleaf)$/;
const OFFSET_XZ = /^(dandelion|golden_dandelion|poppy|blue_orchid|allium|azure_bluet|(red|orange|white|pink)_tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|torchflower|closed_eyeblossom|open_eyeblossom|tall_grass|large_fern|sunflower|lilac|rose_bush|peony|pitcher_plant|bamboo|pointed_dripstone|hanging_roots|mangrove_propagule|crimson_roots|warped_roots|nether_sprouts|firefly_bush)$/;

export const enum Layer { Solid = 0, Cutout = 1, Translucent = 2, None = 3 }

export class BlockInfo {
  readonly emission: Uint8Array;
  readonly lightBlock: Uint8Array;
  readonly skyDown: Uint8Array; // propagatesSkylightDown
  readonly layer: Uint8Array;
  readonly solidRender: Uint8Array;
  readonly shadeFull: Uint8Array; // collision shape is a full block -> AO shade 0.2
  readonly fluid: Uint8Array; // 0 none, 1 water, 2 lava
  readonly fluidLevel: Uint8Array; // vanilla fluid amount (8 = source/falling) for fluid states
  readonly tint: Uint8Array; // per block
  readonly sameCull: Uint8Array; // per block
  readonly offsetType: Uint8Array; // per block
  /** 6 face masks per state, index into masks (0 = empty, 1 = full) */
  readonly faceMask: Uint16Array;
  readonly masks: Uint32Array[] = [new Uint32Array(8), new Uint32Array(8).fill(0xffffffff)];
  readonly airLike: Uint8Array;
  private bakeCache = new Map<number, BakedQuad[]>();

  constructor(readonly reg: BlockRegistry, readonly models: ModelsJson, readonly blocks: BlocksJson) {
    const n = reg.stateCount;
    this.emission = new Uint8Array(n); this.lightBlock = new Uint8Array(n); this.skyDown = new Uint8Array(n);
    this.layer = new Uint8Array(n); this.solidRender = new Uint8Array(n); this.shadeFull = new Uint8Array(n);
    this.fluid = new Uint8Array(n); this.fluidLevel = new Uint8Array(n); this.airLike = new Uint8Array(n);
    this.faceMask = new Uint16Array(n * 6);
    this.tint = new Uint8Array(reg.blocks.length); this.sameCull = new Uint8Array(reg.blocks.length);
    this.offsetType = new Uint8Array(reg.blocks.length);
    const maskIndex = new Map<string, number>([['0,0,0,0,0,0,0,0', 0], [new Array(8).fill(0xffffffff >>> 0).join(','), 1]]);

    reg.blocks.forEach((b, bi) => {
      this.tint[bi] = TINTS[b.name] ?? Tint.None;
      this.sameCull[bi] = SAME_TYPE_CULL.test(b.name) ? 1 : 0;
      this.offsetType[bi] = OFFSET_XYZ.test(b.name) ? 2 : OFFSET_XZ.test(b.name) ? 1 : 0;
      const em = EMISSION[b.name];
      for (let s = b.first; s < b.first + b.count; s++) {
        const props = b.props.length ? reg.props(s) : {};
        this.emission[s] = em === undefined ? 0 : typeof em === 'number' ? em : em(props);
        if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') this.airLike[s] = 1;
        let fluid = 0, level = 0;
        if (b.name === 'water' || b.name === 'lava') {
          fluid = b.name === 'water' ? 1 : 2;
          const l = +props.level; level = l === 0 ? 8 : l >= 8 ? 8 : 8 - l;
          if (l >= 8) level = 8 | 0x10; // falling
        } else if (props.waterlogged === 'true' || b.name === 'bubble_column' || b.name === 'kelp' || b.name === 'kelp_plant' || b.name === 'seagrass' || b.name === 'tall_seagrass') {
          fluid = 1; level = 8;
        }
        this.fluid[s] = fluid; this.fluidLevel[s] = level;

        // Geometry: union of first choices of every part
        let layer = -1; let fullShape = false; let fullCubeModel = false;
        const fm: Uint32Array[] = [0, 1, 2, 3, 4, 5].map(() => new Uint32Array(8));
        for (const pid of blocks.states[s]) {
          const choice = blocks.parts[pid][0];
          const model = models.models[choice.m];
          if (model.elements.length) layer = Math.max(layer, model.layer);
          if (model.fullCube || this.isFullBox(model)) fullShape = true;
          if (model.fullCube) fullCubeModel = true;
          if (model.layer !== 0) continue; // only solid-layer geometry occludes neighbours
          for (const q of this.baked(pid, 0)) {
            if (q.cull < 0 || !q.onBoundary) continue;
            rasterFace(q, fm[q.cull]);
          }
        }
        this.layer[s] = layer < 0 ? Layer.None : layer;
        if (fluid === 2 && layer < 0) this.layer[s] = Layer.None;
        const solid = fullCubeModel && layer === 0 && b.name !== 'barrier';
        this.solidRender[s] = solid ? 1 : 0;
        this.shadeFull[s] = fullShape ? 1 : 0;
        for (let d = 0; d < 6; d++) {
          const key = Array.from(fm[d]).join(',');
          let mi = maskIndex.get(key);
          if (mi === undefined) { mi = this.masks.length; this.masks.push(fm[d]); maskIndex.set(key, mi); }
          this.faceMask[s * 6 + d] = mi;
        }
        // BlockBehaviour.getLightBlock: solid render -> 15, else propagatesSkylightDown ? 0 : 1
        let skyDown = !fullShape && fluid === 0;
        if (/^(glass|[a-z_]+_stained_glass|barrier)$/.test(b.name)) skyDown = true; // TransparentBlock
        if (b.name === 'tinted_glass') { skyDown = false; }
        this.skyDown[s] = skyDown ? 1 : 0;
        this.lightBlock[s] = solid || b.name === 'tinted_glass' ? 15 : skyDown ? 0 : 1;
      }
    });
  }

  private isFullBox(m: { elements: { from: number[]; to: number[]; rotation?: unknown }[] }): boolean {
    return m.elements.length === 1 && !m.elements[0].rotation && m.elements[0].from.every((v) => v === 0) && m.elements[0].to.every((v) => v === 16);
  }

  /** Baked quads for part `pid`, choice index `ci`. */
  baked(pid: number, ci: number): BakedQuad[] {
    const key = pid * 64 + ci;
    let q = this.bakeCache.get(key);
    if (!q) {
      const choice = this.blocks.parts[pid][ci];
      q = bakeChoice(this.models.models[choice.m], choice);
      this.bakeCache.set(key, q);
    }
    return q;
  }

  /** Is `ourFace` of state `s` (direction d) completely hidden by neighbour state `n`? */
  faceHidden(s: number, q: BakedQuad, n: number): boolean {
    const nm = this.faceMask[n * 6 + (q.cull ^ 1)];
    if (nm === 0) {
      return this.sameCull[this.reg.stateBlock[s]] === 1 && this.reg.stateBlock[s] === this.reg.stateBlock[n];
    }
    if (nm === 1) return true;
    const mine = new Uint32Array(8);
    rasterFace(q, mine);
    const theirs = this.masks[nm];
    for (let i = 0; i < 8; i++) if ((mine[i] & ~theirs[i]) !== 0) return false;
    return true;
  }
}

/** Rasterise a boundary quad into a 16x16 bit mask over the face's two in-plane axes. */
function rasterFace(q: BakedQuad, mask: Uint32Array): void {
  const ax = [1, 1, 2, 2, 0, 0][q.cull];
  const o1 = ax === 0 ? 1 : 0, o2 = ax === 2 ? 1 : 2;
  let mn1 = 1, mx1 = 0, mn2 = 1, mx2 = 0;
  for (let i = 0; i < 4; i++) {
    const a = q.pos[i * 3 + o1], b = q.pos[i * 3 + o2];
    mn1 = Math.min(mn1, a); mx1 = Math.max(mx1, a); mn2 = Math.min(mn2, b); mx2 = Math.max(mx2, b);
  }
  const x0 = Math.max(0, Math.round(mn1 * 16)), x1 = Math.min(16, Math.round(mx1 * 16));
  const y0 = Math.max(0, Math.round(mn2 * 16)), y1 = Math.min(16, Math.round(mx2 * 16));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const bit = y * 16 + x;
    mask[bit >> 5] |= 1 << (bit & 31);
  }
}
