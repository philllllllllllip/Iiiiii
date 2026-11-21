// Phase 2 test scene: a 3x3 chunk area exercising AO, block light, liquids, glass, tinting, partial blocks.
import { Chunk } from '../world/chunk';
import type { World } from '../world/world';
import type { BlockRegistry } from '../world/registry';

export function buildTestScene(world: World, reg: BlockRegistry, biome: number): void {
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
    const c = new Chunk(cx, cz);
    c.biomes.fill(biome);
    world.addChunk(c);
  }
  const S = (n: string, p: Record<string, string | number | boolean> = {}) => reg.state(n, p);
  const set = (x: number, y: number, z: number, s: number) => world.setState(x, y, z, s);
  const fill = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, s: number) => {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) set(x, y, z, s);
  };
  const stone = S('stone'), dirt = S('dirt'), grass = S('grass_block'), sand = S('sand');
  fill(-16, 56, -16, 31, 60, 31, stone);
  fill(-16, 61, -16, 31, 63, 31, dirt);
  fill(-16, 64, -16, 31, 64, 31, grass);
  // pond
  fill(2, 62, 2, 8, 64, 8, sand);
  fill(3, 63, 3, 7, 64, 7, S('water'));
  // lava pool
  fill(-10, 64, 4, -8, 64, 6, S('lava'));
  // oak tree
  fill(-4, 65, -6, -4, 69, -6, S('oak_log'));
  for (let x = -6; x <= -2; x++) for (let z = -8; z <= -4; z++) for (let y = 68; y <= 69; y++) if (!(x === -4 && z === -6)) set(x, y, z, S('oak_leaves'));
  fill(-5, 70, -7, -3, 71, -5, S('oak_leaves'));
  // birch tree
  fill(10, 65, -6, 10, 70, -6, S('birch_log'));
  for (let x = 8; x <= 12; x++) for (let z = -8; z <= -4; z++) for (let y = 69; y <= 70; y++) if (!(x === 10 && z === -6)) set(x, y, z, S('birch_leaves'));
  // glass house with glowstone
  fill(14, 65, 2, 18, 68, 6, S('glass'));
  fill(15, 65, 3, 17, 67, 5, 0);
  set(16, 65, 4, S('glowstone'));
  // stone overhang cave with torch (block light + AO)
  fill(-14, 65, -14, -8, 69, -8, S('cobblestone'));
  fill(-13, 65, -13, -9, 67, -8, 0);
  set(-11, 65, -12, S('torch'));
  // stairs, slabs
  for (let i = 0; i < 4; i++) set(0 + i, 65, -12, S('oak_stairs', { facing: 'north' }));
  set(0, 65, -14, S('stone_slab', { type: 'bottom' })); set(1, 65, -14, S('stone_slab', { type: 'top' })); set(2, 65, -14, S('stone_slab', { type: 'double' }));
  fill(4, 65, -14, 6, 65, -14, S('smooth_stone_slab'));
  // 26.3 sulfur blocks
  set(-2, 65, 10, S('sulfur')); set(-1, 65, 10, S('polished_sulfur')); set(0, 65, 10, S('chiseled_sulfur')); set(1, 65, 10, S('potent_sulfur'));
  set(2, 65, 10, S('sulfur_bricks'));
  // vegetation
  const plants = ['short_grass', 'fern', 'poppy', 'dandelion', 'cornflower', 'oxeye_daisy', 'azure_bluet'];
  for (let i = 0; i < 40; i++) {
    const x = ((i * 37) % 28) - 14, z = ((i * 53) % 24) + 0;
    if (world.getState(x, 65, z) === 0 && world.getState(x, 64, z) === grass) set(x, 65, z, S(plants[i % plants.length]));
  }
  set(-6, 65, 12, S('tall_grass', { half: 'lower' })); set(-6, 66, 12, S('tall_grass', { half: 'upper' }));
  // misc blocks row
  const misc = ['oak_planks', 'bricks', 'crafting_table', 'furnace', 'bookshelf', 'diamond_ore', 'iron_block', 'gold_block', 'emerald_block', 'tnt', 'pumpkin', 'melon', 'hay_block', 'white_wool', 'red_wool', 'blue_stained_glass'];
  misc.forEach((n, i) => set(-8 + i, 65, 16, S(n)));
  set(-8, 66, 16, S('oak_fence')); set(-7, 66, 16, S('oak_fence'));
  set(-6, 66, 16, S('lantern', { hanging: false }));
}
