// Item registry from the 26.3 item components report, item<->block mapping, tool rules.
import type { BlockRegistry } from '../world/registry';
import type { Tags } from '../worldgen/features';

export interface ItemStack { id: number; count: number; damage?: number; components?: Record<string, any> }

/** BlockItem registrations whose item id differs from the block id (Items.java). */
const ITEM_TO_BLOCK: Record<string, string> = {
  wheat_seeds: 'wheat', beetroot_seeds: 'beetroots', melon_seeds: 'melon_stem', pumpkin_seeds: 'pumpkin_stem', carrot: 'carrots', potato: 'potatoes',
  torchflower_seeds: 'torchflower_crop', pitcher_pod: 'pitcher_crop', redstone: 'redstone_wire', string: 'tripwire', sweet_berries: 'sweet_berry_bush',
  glow_berries: 'cave_vines', cocoa_beans: 'cocoa', nether_wart: 'nether_wart', kelp: 'kelp', bamboo: 'bamboo_sapling', powder_snow_bucket: 'powder_snow',
};
/** Standing/wall pairs: item places the standing block, or the wall block when clicking a side. */
export const WALL_VARIANT: Record<string, string> = {
  torch: 'wall_torch', soul_torch: 'soul_wall_torch', redstone_torch: 'redstone_wall_torch', copper_torch: 'copper_wall_torch',
};

export class ItemRegistry {
  readonly names: string[];
  readonly byName = new Map<string, number>();
  readonly components: Record<string, any>[];
  readonly blockOf: Int32Array;      // item -> default state of its block (-1 none)
  readonly itemOfBlock: Int32Array;  // block index -> item id (-1 none)
  constructor(itemNames: string[], comps: Record<string, any>, readonly reg: BlockRegistry, readonly tags: Tags) {
    this.names = itemNames;
    this.components = itemNames.map((n) => comps[n] ?? {});
    itemNames.forEach((n, i) => this.byName.set(n, i));
    this.blockOf = new Int32Array(itemNames.length).fill(-1);
    this.itemOfBlock = new Int32Array(reg.blocks.length).fill(-1);
    itemNames.forEach((n, i) => {
      const bn = ITEM_TO_BLOCK[n] ?? n;
      const bi = reg.byName.get(bn);
      if (bi !== undefined && !(n in ITEM_TO_BLOCK && false)) { this.blockOf[i] = reg.blocks[bi].def; }
    });
    reg.blocks.forEach((b, bi) => {
      let it = this.byName.get(b.name);
      if (it === undefined) {
        const inv = Object.entries(ITEM_TO_BLOCK).find(([, v]) => v === b.name)?.[0];
        if (inv) it = this.byName.get(inv);
        const wall = Object.entries(WALL_VARIANT).find(([, v]) => v === b.name)?.[0] ?? (b.name.includes('_wall_') ? b.name.replace('_wall_', '_') : undefined);
        if (it === undefined && wall) it = this.byName.get(wall);
      }
      if (it !== undefined) this.itemOfBlock[bi] = it;
    });
  }
  id(name: string): number { const i = this.byName.get(name.replace('minecraft:', '')); if (i === undefined) throw new Error('unknown item ' + name); return i; }
  name(id: number): string { return this.names[id]; }
  comp(id: number, key: string): any { return this.components[id]['minecraft:' + key]; }
  maxStack(id: number): number { return this.comp(id, 'max_stack_size') ?? 64; }
  maxDamage(id: number): number { return this.comp(id, 'max_damage') ?? 0; }

  /** Tool.getMiningSpeed / isCorrectForDrops: first rule matching the block decides. */
  toolRule(item: number | null, state: number): { speed: number; correct: boolean | null } {
    const tool = item === null ? undefined : this.comp(item, 'tool');
    if (!tool) return { speed: 1, correct: null };
    for (const r of tool.rules) {
      const blocks = r.blocks as string | string[];
      const bi = this.reg.stateBlock[state];
      const match = typeof blocks === 'string'
        ? (blocks.startsWith('#') ? this.tags.block(blocks).has(bi) : this.reg.blocks[bi].name === blocks.replace('minecraft:', ''))
        : blocks.some((b) => (b.startsWith('#') ? this.tags.block(b).has(bi) : this.reg.blocks[bi].name === b.replace('minecraft:', '')));
      if (match) return { speed: r.speed ?? tool.default_mining_speed ?? 1, correct: r.correct_for_drops ?? null };
    }
    return { speed: tool.default_mining_speed ?? 1, correct: null };
  }
}
