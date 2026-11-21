// Environment attributes driven by 26.3 timelines (data/minecraft/timeline/*.json).
// Each track has keyframes over the clock period, linear (or cubic_bezier eased) interpolation that
// wraps around the period, and a modifier applied to the base attribute value
// (from the dimension type, overridden by the biome).
export type Attr = number | string | boolean;

interface Track { ease?: string | { cubic_bezier: number[] }; modifier?: string; keyframes: { ticks: number; value: Attr }[] }
interface Timeline { clock: string; period_ticks?: number; tracks: Record<string, Track> }

export function parseColor(s: string): [number, number, number, number] {
  const h = s.replace('#', '');
  const v = parseInt(h, 16);
  if (h.length === 8) return [((v >>> 16) & 255) / 255, ((v >>> 8) & 255) / 255, (v & 255) / 255, ((v >>> 24) & 255) / 255];
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1];
}
const toHex = (c: number[]) => '#' + [c[3], c[0], c[1], c[2]].map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('');

/** Solve a CSS-style cubic bezier (0,0)-(x1,y1)-(x2,y2)-(1,1) for y at x. */
function bezier(x: number, [x1, y1, x2, y2]: number[]): number {
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = (t: number) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (bx(m) < x) lo = m; else hi = m; }
  return by((lo + hi) / 2);
}

function lerpAttr(a: Attr, b: Attr, t: number): Attr {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  if (typeof a === 'string' && typeof b === 'string' && a.startsWith('#')) {
    const ca = parseColor(a), cb = parseColor(b);
    return toHex(ca.map((v, i) => v + (cb[i] - v) * t));
  }
  return t < 1 ? a : b;
}

export function sampleTrack(tr: Track, period: number, time: number): Attr {
  const k = [...tr.keyframes];
  const t = ((time % period) + period) % period;
  let i = -1;
  for (let j = 0; j < k.length; j++) if (k[j].ticks <= t) i = j;
  let from: { ticks: number; value: Attr }, to: { ticks: number; value: Attr };
  if (i === -1) { from = { ...k[k.length - 1], ticks: k[k.length - 1].ticks - period }; to = k[0]; }
  else if (i === k.length - 1) { from = k[i]; to = { ...k[0], ticks: k[0].ticks + period }; }
  else { from = k[i]; to = k[i + 1]; }
  if (tr.ease === 'constant') return from.value;
  const span = to.ticks - from.ticks;
  let f = span <= 0 ? 0 : (t - from.ticks) / span;
  if (tr.ease && typeof tr.ease === 'object' && tr.ease.cubic_bezier) f = bezier(f, tr.ease.cubic_bezier);
  return lerpAttr(from.value, to.value, f);
}

function applyModifier(base: Attr | undefined, v: Attr, mod: string | undefined): Attr {
  if (base === undefined || !mod || mod === 'override') return v;
  if (typeof base === 'number' && typeof v === 'number') {
    if (mod === 'multiply') return base * v;
    if (mod === 'maximum') return Math.max(base, v);
    if (mod === 'minimum') return Math.min(base, v);
    if (mod === 'add') return base + v;
  }
  if (typeof base === 'string' && typeof v === 'string' && mod === 'multiply') {
    const a = parseColor(base), b = parseColor(v);
    return toHex(a.map((x, i) => x * b[i]));
  }
  if (typeof base === 'boolean' && typeof v === 'boolean') return mod === 'or' ? base || v : mod === 'and' ? base && v : v;
  return v;
}

/** Defaults for attributes whose default values live in game code (see DEVIATIONS.md). */
export const ATTRIBUTE_DEFAULTS: Record<string, Attr> = {
  'minecraft:visual/sky_color': '#000000',
  'minecraft:visual/fog_color': '#000000',
  'minecraft:visual/cloud_color': '#00000000',
  'minecraft:visual/cloud_height': 192.33,
  'minecraft:visual/ambient_light_color': '#000000',
  'minecraft:visual/block_light_tint': '#ffd88c',
  'minecraft:visual/sky_light_color': '#ffffff',
  'minecraft:visual/sky_light_factor': 1,
  'minecraft:visual/night_vision_color': '#999999',
  'minecraft:visual/sun_angle': 0, 'minecraft:visual/moon_angle': 180, 'minecraft:visual/star_angle': 0,
  'minecraft:visual/star_brightness': 0,
  'minecraft:visual/sunrise_sunset_color': '#00000000',
  'minecraft:visual/moon_phase': 'full_moon',
  'minecraft:visual/fog_start_distance': 0, 'minecraft:visual/fog_end_distance': 1024,
  'minecraft:visual/sky_fog_end_distance': 512, 'minecraft:visual/cloud_fog_end_distance': 2048,
  'minecraft:visual/water_fog_color': '#050533', 'minecraft:visual/water_fog_start_distance': -8, 'minecraft:visual/water_fog_end_distance': 96,
  'minecraft:gameplay/sky_light_level': 1,
};

export class Environment {
  private timelines: Timeline[] = [];
  constructor(readonly data: { timeline: Record<string, Timeline>; tags: Record<string, { values: string[] }> }, readonly dimension: any) {
    const resolve = (ref: string, out: Set<string>) => {
      if (ref.startsWith('#')) {
        const tag = data.tags[ref.slice(1).replace('minecraft:', '')];
        if (!tag) throw new Error('missing timeline tag ' + ref);
        for (const v of tag.values) resolve(v, out);
      } else out.add(ref.replace('minecraft:', ''));
    };
    const names = new Set<string>();
    resolve(dimension.timelines, names);
    for (const n of names) {
      const t = data.timeline[n];
      if (!t) throw new Error('missing timeline ' + n);
      this.timelines.push(t);
    }
  }

  /** Attribute value at a game time for a biome's attribute overrides. */
  get(name: string, time: number, biomeAttrs: Record<string, any> = {}): Attr {
    let base: Attr = ATTRIBUTE_DEFAULTS[name];
    const dim = this.dimension.attributes?.[name];
    if (dim !== undefined) base = applyModifier(base, typeof dim === 'object' && dim.argument !== undefined ? dim.argument : dim, typeof dim === 'object' ? dim.modifier : undefined);
    const bio = biomeAttrs[name];
    if (bio !== undefined) base = typeof bio === 'object' && bio !== null && 'argument' in bio ? applyModifier(base, bio.argument, bio.modifier) : bio;
    for (const tl of this.timelines) {
      const tr = tl.tracks[name];
      if (!tr) continue;
      base = applyModifier(base, sampleTrack(tr, tl.period_ticks ?? 24000, time), tr.modifier);
    }
    if (base === undefined) throw new Error('attribute without value: ' + name);
    return base;
  }
  color(name: string, time: number, biomeAttrs?: Record<string, any>): [number, number, number, number] {
    return parseColor(this.get(name, time, biomeAttrs) as string);
  }
  num(name: string, time: number, biomeAttrs?: Record<string, any>): number { return this.get(name, time, biomeAttrs) as number; }
}
