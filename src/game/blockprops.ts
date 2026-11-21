// Gameplay block properties that vanilla keeps in Blocks.java (hardness, friction, speed/jump factors,
// collision presence) plus collision shapes derived from the baked models. Tool categories and tiers
// come from the 26.3 tags (mineable/*, needs_*_tool, incorrect_for_*_tool).
import type { BlockRegistry } from '../world/registry';
import type { BlockInfo } from '../world/blockinfo';
import type { Tags } from '../worldgen/features';

export type AABB = [number, number, number, number, number, number];

/** Destroy time (hardness). First matching rule wins. -1 = unbreakable. */
const HARDNESS: [RegExp, number][] = [
  [/^(bedrock|barrier|command_block|chain_command_block|repeating_command_block|structure_block|structure_void|jigsaw|end_portal|end_gateway|end_portal_frame|light|moving_piston|nether_portal|reinforced_deepslate|test_block|test_instance_block|trial_spawner|vault)$/, -1],
  [/^(air|cave_air|void_air|water|lava|fire|soul_fire|bubble_column)$/, -1],
  [/^(short_grass|tall_grass|fern|large_fern|dead_bush|bush|seagrass|tall_seagrass|kelp|kelp_plant|torch|wall_torch|soul_torch|soul_wall_torch|copper_torch|copper_wall_torch|redstone_torch|redstone_wall_torch|redstone_wire|tripwire|tripwire_hook|lever_none|flower_pot|potted_.*|sugar_cane|lily_pad|sweet_berry_bush|wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|attached_.*_stem|nether_wart|cocoa_none|.*_sapling|.*_tulip|poppy|dandelion|golden_dandelion|allium|azure_bluet|blue_orchid|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|torchflower|torchflower_crop|pitcher_crop|sunflower|lilac|rose_bush|peony|pitcher_plant|brown_mushroom|red_mushroom|crimson_fungus|warped_fungus|crimson_roots|warped_roots|nether_sprouts|hanging_roots|spore_blossom|pink_petals|wildflowers|leaf_litter|cave_vines|cave_vines_plant|glow_lichen|small_dripleaf|big_dripleaf_stem|slime_block|honey_block|frogspawn|tnt|repeater|comparator|scaffolding|firefly_bush|short_dry_grass|tall_dry_grass|open_eyeblossom|closed_eyeblossom|cactus_flower|moss_carpet|pale_moss_carpet|pale_hanging_moss|sea_pickle|resin_clump|mangrove_propagule)$/, 0],
  [/^(vine|weeping_vines.*|twisting_vines.*|sculk_vein|ladder)$/, 0.2],
  [/_leaves$/, 0.2], [/^(snow|cobweb_x)$/, 0.1], [/^(powder_snow)$/, 0.25],
  [/^(glass|tinted_glass|.*_stained_glass|glass_pane|.*_stained_glass_pane|glowstone|sea_lantern|redstone_lamp|beacon_x)$/, 0.3],
  [/^(ice|packed_ice|frosted_ice)$/, 0.5], [/^blue_ice$/, 2.8],
  [/_carpet$/, 0.1], [/_bed$/, 0.2], [/^(cake|candle_cake|.*_candle_cake)$/, 0.5], [/candle$/, 0.1],
  [/^(dirt|coarse_dirt|rooted_dirt|farmland|sand|red_sand|suspicious_sand|soul_sand|soul_soil|clay|mud|muddy_mangrove_roots_x|dirt_path|podzol_x|mycelium_x|.*concrete_powder|sponge_x)$/, 0.5],
  [/^(grass_block|podzol|mycelium|gravel|suspicious_gravel|sponge|wet_sponge|hay_block|target|moss_block|pale_moss_block|dried_kelp_block_x)$/, 0.6],
  [/^(netherrack|nylium|crimson_nylium|warped_nylium)$/, 0.4],
  [/^(cactus|ladder_x|chorus_plant|chorus_flower|.*_wool|white_banner_x)$/, 0.4], [/_wool$/, 0.8],
  [/^(note_block|bamboo_x)$/, 0.8], [/^(sandstone|red_sandstone|.*_sandstone|.*sandstone_stairs|.*sandstone_wall|quartz_block|quartz_bricks|quartz_pillar|chiseled_quartz_block|quartz_stairs)$/, 0.8],
  [/^(rail|powered_rail|detector_rail|activator_rail)$/, 0.7],
  [/^(.*_button|stone_pressure_plate|.*_pressure_plate|lever)$/, 0.5],
  [/^(dried_kelp_block)$/, 0.5], [/^(mushroom_stem|brown_mushroom_block|red_mushroom_block)$/, 0.2],
  [/^(melon|pumpkin|carved_pumpkin|jack_o_lantern|bee_nest|honeycomb_block|nether_wart_block|warped_wart_block|shroomlight|creeper_head_x)$/, 1],
  [/^(beehive|bookshelf|chiseled_bookshelf|.*_sign|.*_wall_sign|.*_hanging_sign|.*_wall_hanging_sign|.*_banner|.*_wall_banner|dried_ghast)$/, 1.5],
  [/^(.*_head|.*_wall_head|.*_skull|.*_wall_skull)$/, 1],
  [/^(bamboo|bamboo_sapling)$/, 1],
  [/^(stone|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|chiseled_stone_bricks|.*stone_brick_stairs|.*stone_brick_slab|.*stone_brick_wall|smooth_stone|smooth_stone_slab|stone_stairs|stone_slab|andesite|diorite|granite|polished_andesite|polished_diorite|polished_granite|.*_andesite_.*|.*_diorite_.*|.*_granite_.*|andesite_.*|diorite_.*|granite_.*|prismarine.*|dark_prismarine.*|purpur.*|end_stone_brick.*|calcite|dripstone_block|pointed_dripstone|amethyst_block|budding_amethyst|tuff.*|polished_tuff.*|chiseled_tuff.*|mud_brick.*|packed_mud|infested_.*|sulfur.*|polished_sulfur.*|chiseled_sulfur|potent_sulfur)$/, 1.5],
  [/^(cobblestone|mossy_cobblestone|cobblestone_.*|mossy_cobblestone_.*|bricks|brick_.*|.*_planks|.*_log|.*_wood|stripped_.*|.*_stem|.*_hyphae|.*_fence|.*_fence_gate|.*_slab|.*_stairs|crafting_table|lectern|campfire|soul_campfire|jukebox|smithing_table|fletching_table|cartography_table|loom|barrel|composter_x|bamboo_block|stripped_bamboo_block|bamboo_mosaic.*|nether_bricks|.*nether_brick.*|.*_shelf|cauldron|.*_cauldron|grindstone|shulker_box|.*_shulker_box|piston_head_x)$/, 2],
  [/^(composter)$/, 0.6], [/^(chest|trapped_chest|.*_door|.*_trapdoor)$/, 2.5],
  [/^(furnace|blast_furnace|smoker|dispenser|dropper|lantern|soul_lantern|.*copper_lantern|chain|.*_chain|stonecutter|hopper_x|.*_ore|gold_block_x|lapis_block|redstone_block|coal_block_x|end_stone|crafter|conduit|deepslate_x|.*_terracotta|terracotta|glazed_x)$/, 3.5],
  [/^(deepslate_.*_ore)$/, 4.5], [/^(.*_ore)$/, 3], [/^(nether_quartz_ore|nether_gold_ore)$/, 3],
  [/^(terracotta|.*_terracotta)$/, 1.25], [/_glazed_terracotta$/, 1.4], [/_concrete$/, 1.8],
  [/^(deepslate|cobbled_deepslate.*|polished_deepslate.*|deepslate_.*|chiseled_deepslate|cracked_deepslate_.*)$/, 3.5],
  [/^(blackstone.*|polished_blackstone.*|gilded_blackstone|chiseled_polished_blackstone)$/, 1.5],
  [/^(basalt|polished_basalt|smooth_basalt|magma_block)$/, 1.25], [/^(magma_block)$/, 0.5],
  [/^(coal_block|gold_block|diamond_block|emerald_block|raw_iron_block|raw_copper_block|raw_gold_block|iron_bars|.*copper_bars|copper_bulb|.*copper_bulb|cut_copper.*|.*_cut_copper.*|copper_block|.*_copper|.*copper_door|.*copper_trapdoor|copper_grate|.*copper_grate|chiseled_copper|.*chiseled_copper|lightning_rod|.*lightning_rod|heavy_core|spawner|bell|enchanting_table|anvil|chipped_anvil|damaged_anvil|iron_door|iron_trapdoor|hopper|cauldron)$/, 5],
  [/^(iron_block|netherite_block_x)$/, 5], [/^(obsidian|netherite_block)$/, 50], [/^crying_obsidian$/, 50], [/^respawn_anchor$/, 50], [/^ender_chest$/, 22.5], [/^ancient_debris$/, 30],
  [/^(sculk|sculk_catalyst|sculk_sensor|calibrated_sculk_sensor|sculk_shrieker)$/, 0.2], [/^(sculk_catalyst|sculk_shrieker)$/, 3],
  [/^(brewing_stand|end_rod|daylight_detector|observer|piston|sticky_piston|lodestone|creaking_heart|dragon_egg)$/, 3],
  [/^(clay|honeycomb_block)$/, 0.6], [/^(oak_leaves)$/, 0.2],
];

/** Blocks with no collision box (BlockBehaviour.Properties.noCollision()). */
const NO_COLLISION = /^(air|cave_air|void_air|water|lava|fire|soul_fire|bubble_column|short_grass|tall_grass|fern|large_fern|dead_bush|bush|seagrass|tall_seagrass|kelp|kelp_plant|torch|wall_torch|soul_torch|soul_wall_torch|copper_torch|copper_wall_torch|redstone_torch|redstone_wall_torch|redstone_wire|tripwire|tripwire_hook|.*_button|.*_pressure_plate|lever|.*_sign|.*_wall_sign|.*_hanging_sign|.*_wall_hanging_sign|.*_banner|.*_wall_banner|sugar_cane|sweet_berry_bush|wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|attached_.*_stem|nether_wart|.*_sapling|.*_tulip|poppy|dandelion|golden_dandelion|allium|azure_bluet|blue_orchid|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|torchflower|torchflower_crop|pitcher_crop|sunflower|lilac|rose_bush|peony|pitcher_plant|brown_mushroom|red_mushroom|crimson_fungus|warped_fungus|crimson_roots|warped_roots|nether_sprouts|hanging_roots|spore_blossom|cave_vines|cave_vines_plant|glow_lichen|vine|weeping_vines.*|twisting_vines.*|sculk_vein|nether_portal|end_portal|end_gateway|light|structure_void|rail|powered_rail|detector_rail|activator_rail|cobweb|pink_petals|wildflowers|leaf_litter|firefly_bush|short_dry_grass|tall_dry_grass|open_eyeblossom|closed_eyeblossom|cactus_flower|pale_hanging_moss|resin_clump|frogspawn|powder_snow|small_dripleaf|big_dripleaf_stem|mangrove_propagule|scaffolding_x)$/;

const FRICTION: [RegExp, number][] = [[/^(ice|packed_ice|frosted_ice)$/, 0.98], [/^blue_ice$/, 0.989], [/^slime_block$/, 0.8]];
const SPEED_FACTOR: [RegExp, number][] = [[/^(soul_sand|honey_block)$/, 0.4]];
const JUMP_FACTOR: [RegExp, number][] = [[/^honey_block$/, 0.5]];

function lookup(name: string, table: [RegExp, number][], def: number): number {
  for (const [re, v] of table) if (re.test(name)) return v;
  return def;
}

export class BlockProps {
  readonly hardness: Float32Array; // per block
  readonly friction: Float32Array; readonly speedFactor: Float32Array; readonly jumpFactor: Float32Array;
  readonly noCollision: Uint8Array;
  readonly climbable = new Set<number>();
  readonly replaceable = new Set<number>();
  private shapes = new Map<number, AABB[]>();
  constructor(readonly reg: BlockRegistry, readonly info: BlockInfo, readonly tags: Tags) {
    const n = reg.blocks.length;
    this.hardness = new Float32Array(n); this.friction = new Float32Array(n); this.speedFactor = new Float32Array(n); this.jumpFactor = new Float32Array(n);
    this.noCollision = new Uint8Array(n);
    reg.blocks.forEach((b, i) => {
      this.hardness[i] = lookup(b.name, HARDNESS, 1.5);
      this.friction[i] = lookup(b.name, FRICTION, 0.6);
      this.speedFactor[i] = lookup(b.name, SPEED_FACTOR, 1);
      this.jumpFactor[i] = lookup(b.name, JUMP_FACTOR, 1);
      this.noCollision[i] = NO_COLLISION.test(b.name) ? 1 : 0;
    });
    for (const b of tags.block('climbable')) this.climbable.add(b);
    for (const b of tags.block('replaceable')) this.replaceable.add(b);
  }

  /** Collision boxes in block-local [0,1] space (from the model, with vanilla's 1.5-high fences/walls/gates). */
  collision(state: number): AABB[] {
    let s = this.shapes.get(state);
    if (s) return s;
    const bi = this.reg.stateBlock[state]; const name = this.reg.blocks[bi].name;
    s = [];
    if (!this.noCollision[bi]) {
      if (name === 'snow') {
        const layers = +(this.reg.prop(state, 'layers') ?? 1);
        if (layers > 1) s.push([0, 0, 0, 1, (layers - 1) / 8, 1]);
      } else if (/_fence_gate$/.test(name)) {
        if (this.reg.prop(state, 'open') !== 'true') {
          const ax = this.reg.prop(state, 'facing') === 'east' || this.reg.prop(state, 'facing') === 'west';
          s.push(ax ? [0.375, 0, 0, 0.625, 1.5, 1] : [0, 0, 0.375, 1, 1.5, 0.625]);
        }
      } else {
        for (const pid of this.info.blocks.states[state]) {
          const model = this.info.models.models[this.info.blocks.parts[pid][0].m];
          const ch = this.info.blocks.parts[pid][0];
          for (const el of model.elements) {
            if (el.rotation && (el.rotation.angle ?? 0) !== 0) continue;
            let box: AABB = [el.from[0] / 16, el.from[1] / 16, el.from[2] / 16, el.to[0] / 16, el.to[1] / 16, el.to[2] / 16];
            if ((box[3] - box[0]) * (box[4] - box[1]) * (box[5] - box[2]) <= 0 && name !== 'lily_pad') continue;
            box = rotateBox(box, ch.x ?? 0, ch.y ?? 0);
            s.push(box);
          }
        }
        if (/_fence$|_wall$/.test(name)) s = s.map((b) => [b[0], b[1], b[2], b[3], Math.max(b[4], 1.5), b[5]] as AABB);
        if (name === 'lily_pad') s = [[0.0625, 0, 0.0625, 0.9375, 0.09375, 0.9375]];
        if (/_carpet$/.test(name)) s = [[0, 0, 0, 1, 0.0625, 1]];
        if (/_leaves$/.test(name) || this.info.solidRender[state]) s = [[0, 0, 0, 1, 1, 1]];
      }
    }
    this.shapes.set(state, s);
    return s;
  }

  /** Outline (selection) shape: model boxes even for blocks without collision. */
  outline(state: number): AABB[] {
    const out: AABB[] = [];
    for (const pid of this.info.blocks.states[state]) {
      const model = this.info.models.models[this.info.blocks.parts[pid][0].m];
      const ch = this.info.blocks.parts[pid][0];
      for (const el of model.elements) {
        let box: AABB = [el.from[0] / 16, el.from[1] / 16, el.from[2] / 16, el.to[0] / 16, el.to[1] / 16, el.to[2] / 16];
        if (el.rotation && (el.rotation.angle ?? 0) !== 0) box = [Math.min(box[0], 0.1), box[1], Math.min(box[2], 0.1), Math.max(box[3], 0.9), box[4], Math.max(box[5], 0.9)];
        out.push(rotateBox(box, ch.x ?? 0, ch.y ?? 0));
      }
    }
    if (!out.length) return [];
    // vanilla outlines are merged shapes; union bounding box keeps the visual close for complex models
    if (out.length > 6) {
      const u: AABB = [1, 1, 1, 0, 0, 0];
      for (const b of out) for (let i = 0; i < 3; i++) { u[i] = Math.min(u[i], b[i]); u[i + 3] = Math.max(u[i + 3], b[i + 3]); }
      return [u];
    }
    return out;
  }
}

function rotateBox(b: AABB, x: number, y: number): AABB {
  let r = b;
  const rx = ((x % 360) + 360) % 360, ry = ((y % 360) + 360) % 360;
  // same transform as the baker's variant matrix rotY(-y) * rotX(-x)
  for (let i = 0; i < rx / 90; i++) r = [r[0], r[2], 1 - r[4], r[3], r[5], 1 - r[1]];
  for (let i = 0; i < ry / 90; i++) r = [1 - r[5], r[1], r[0], 1 - r[2], r[4], r[3]];
  return r;
}
