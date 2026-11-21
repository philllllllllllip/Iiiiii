// Loot table evaluation (LootTable / LootPool / entries / conditions / functions) for block and
// entity drops and chest loot, driven by data/minecraft/loot_table/*.json.
import type { ItemRegistry, ItemStack } from './items';
import type { BlockRegistry } from '../world/registry';

export interface LootContext {
  rng: () => number;
  tool?: ItemStack | null;
  state?: number;
  explosionRadius?: number;
  killedByPlayer?: boolean;
  enchantLevel?: (stack: ItemStack | null | undefined, ench: string) => number;
  looting?: number;
}

export class LootTables {
  constructor(readonly tables: Record<string, any>, readonly items: ItemRegistry, readonly reg: BlockRegistry) {}

  roll(name: string, ctx: LootContext): ItemStack[] {
    const t = this.tables[name.replace('minecraft:', '')];
    if (!t) return [];
    const out: ItemStack[] = [];
    for (const pool of t.pools ?? []) {
      if (!this.conds(pool.conditions, ctx)) continue;
      const rolls = Math.floor(this.num(pool.rolls ?? 1, ctx) + this.num(pool.bonus_rolls ?? 0, ctx) * (ctx.looting ?? 0));
      for (let r = 0; r < rolls; r++) {
        const chosen = this.pick(pool.entries, ctx);
        for (const s of chosen) { const fs = [...(s.fns ?? []), ...(pool.functions ?? [])]; const st = this.applyFns(s.stack, fs, ctx); if (st && st.count > 0) out.push(st); }
      }
    }
    return out.map((s) => this.applyFns(s, t.functions ?? [], ctx)).filter((s): s is ItemStack => !!s && s.count > 0);
  }

  private num(v: any, ctx: LootContext): number {
    if (typeof v === 'number') return v;
    const t = String(v.type ?? 'constant').replace('minecraft:', '');
    if (t === 'uniform') return this.num(v.min, ctx) + ctx.rng() * (this.num(v.max, ctx) - this.num(v.min, ctx));
    if (t === 'binomial') { let c = 0; const n = this.num(v.n, ctx), p = this.num(v.p, ctx); for (let i = 0; i < n; i++) if (ctx.rng() < p) c++; return c; }
    if (t === 'constant') return v.value;
    return 1;
  }

  /** Returns the leaf item entries chosen from an entry list (weighted single pick among expanded entries). */
  private pick(entries: any[], ctx: LootContext): { stack: ItemStack; fns?: any[] }[] {
    const expanded: { e: any; w: number }[] = [];
    const expand = (list: any[]) => {
      for (const e of list) {
        if (!this.conds(e.conditions, ctx)) continue;
        const t = String(e.type).replace('minecraft:', '');
        if (t === 'alternatives') { for (const c of e.children) { if (this.conds(c.conditions, ctx)) { expand([{ ...c, conditions: [] }]); break; } } }
        else if (t === 'group') { for (const c of e.children) expand([c]); }
        else if (t === 'sequence') { for (const c of e.children) { if (!this.conds(c.conditions, ctx)) break; expand([{ ...c, conditions: [] }]); } }
        else expanded.push({ e, w: Math.max(0, Math.floor((e.weight ?? 1) + (e.quality ?? 0) * (ctx.looting ?? 0))) });
      }
    };
    expand(entries);
    if (!expanded.length) return [];
    const total = expanded.reduce((a, b) => a + b.w, 0);
    let p = Math.floor(ctx.rng() * total);
    for (const x of expanded) {
      p -= x.w;
      if (p < 0) {
        const t = String(x.e.type).replace('minecraft:', '');
        if (t === 'item') return [{ stack: { id: this.items.id(x.e.name), count: 1 }, fns: x.e.functions }];
        if (t === 'loot_table') return this.roll(typeof x.e.value === 'string' ? x.e.value : x.e.name, ctx).map((stack) => ({ stack }));
        if (t === 'tag') {
          const vals = (this.items as any).tags?.tags?.['item/' + String(x.e.name).replace('minecraft:', '')]?.values ?? [];
          return vals.length ? [{ stack: { id: this.items.id(vals[Math.floor(ctx.rng() * vals.length)]), count: 1 }, fns: x.e.functions }] : [];
        }
        return [];
      }
    }
    return [];
  }

  private conds(cs: any[] | undefined, ctx: LootContext): boolean {
    if (!cs) return true;
    return cs.every((c) => this.cond(c, ctx));
  }
  private cond(c: any, ctx: LootContext): boolean {
    const t = String(c.condition).replace('minecraft:', '');
    switch (t) {
      case 'survives_explosion': return ctx.explosionRadius ? ctx.rng() <= 1 / ctx.explosionRadius : true;
      case 'random_chance': return ctx.rng() < (typeof c.chance === 'number' ? c.chance : this.num(c.chance, ctx));
      case 'random_chance_with_enchanted_bonus': return ctx.rng() < (c.unenchanted_chance ?? 0.05);
      case 'killed_by_player': return !!ctx.killedByPlayer;
      case 'inverted': return !this.cond(c.term, ctx);
      case 'any_of': case 'alternative': return (c.terms ?? []).some((x: any) => this.cond(x, ctx));
      case 'all_of': return (c.terms ?? []).every((x: any) => this.cond(x, ctx));
      case 'block_state_property': {
        if (ctx.state === undefined) return false;
        for (const [k, v] of Object.entries(c.properties ?? {})) {
          const cur = this.reg.prop(ctx.state, k);
          if (typeof v === 'object' && v) { const n = +(cur ?? 0); const mn = (v as any).min, mx = (v as any).max; if ((mn !== undefined && n < mn) || (mx !== undefined && n > mx)) return false; }
          else if (cur !== String(v)) return false;
        }
        return true;
      }
      case 'match_tool': return this.matchTool(c.predicate, ctx);
      case 'table_bonus': {
        const lvl = ctx.enchantLevel?.(ctx.tool, c.enchantment) ?? 0;
        const ch = c.chances[Math.min(lvl, c.chances.length - 1)];
        return ctx.rng() < ch;
      }
      case 'entity_properties': case 'damage_source_properties': case 'location_check': case 'weather_check': case 'time_check': case 'value_check': case 'enchantment_active_check':
        return false;
      default: return true;
    }
  }
  private matchTool(p: any, ctx: LootContext): boolean {
    if (!p) return true;
    const tool = ctx.tool;
    if (p.items) {
      const want = (Array.isArray(p.items) ? p.items : [p.items]) as string[];
      if (!tool) return false;
      const name = this.items.name(tool.id);
      const ok = want.some((w) => (w.startsWith('#') ? ((this.items as any).tags?.tags?.['item/' + w.slice(1).replace('minecraft:', '')]?.values ?? []).map((v: string) => v.replace('minecraft:', '')).includes(name) : w.replace('minecraft:', '') === name));
      if (!ok) return false;
    }
    const ench = p.predicates?.['minecraft:enchantments'];
    if (ench) for (const e of ench) { const lvl = ctx.enchantLevel?.(tool, String(e.enchantments)) ?? 0; if (lvl < (e.levels?.min ?? 1)) return false; }
    return true;
  }

  private applyFns(s: ItemStack, fns: any[], ctx: LootContext): ItemStack | null {
    let st: ItemStack | null = { ...s };
    for (const f of fns) {
      if (!st) break;
      if (!this.conds(f.conditions, ctx)) continue;
      const t = String(f.function).replace('minecraft:', '');
      switch (t) {
        case 'set_count': { const n = Math.floor(this.num(f.count, ctx)); st.count = f.add ? st.count + n : n; break; }
        case 'limit_count': { const lim = f.limit; if (typeof lim === 'number') st.count = Math.min(st.count, lim); else { if (lim.min !== undefined) st.count = Math.max(st.count, this.num(lim.min, ctx)); if (lim.max !== undefined) st.count = Math.min(st.count, this.num(lim.max, ctx)); } break; }
        case 'explosion_decay': if (ctx.explosionRadius) { let c = 0; for (let i = 0; i < st.count; i++) if (ctx.rng() <= 1 / ctx.explosionRadius) c++; st.count = c; } break;
        case 'apply_bonus': {
          const lvl = ctx.enchantLevel?.(ctx.tool, f.enchantment) ?? 0;
          if (lvl <= 0) break;
          const fm = String(f.formula).replace('minecraft:', '');
          if (fm === 'ore_drops') { const b = Math.floor(ctx.rng() * (lvl + 2)) - 1; st.count *= Math.max(0, b) + 1; }
          else if (fm === 'uniform_bonus_count') st.count += Math.floor(ctx.rng() * (f.parameters.bonusMultiplier * lvl + 1));
          else if (fm === 'binomial_with_bonus_count') { const n = lvl + f.parameters.extra; for (let i = 0; i < n; i++) if (ctx.rng() < f.parameters.probability) st.count++; }
          break;
        }
        case 'enchanted_count_increase': case 'looting_enchant': if (ctx.looting) st.count += Math.floor(ctx.rng() * (this.num(f.count, ctx) * ctx.looting + 1)); break;
        case 'furnace_smelt': break;
        default: break; // component-setting functions (names, NBT, banners...) don't change the item id/count
      }
    }
    return st;
  }
}
