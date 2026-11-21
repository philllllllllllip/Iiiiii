// Multi-noise biome source. The overworld parameter list is a reconstruction of OverworldBiomeBuilder
// (the list lives in game code, not in the data pack). 26.3 additions dappled_forest and sulfur_caves
// are placed by best inference — see DEVIATIONS.md.
type P = [number, number]; // parameter range (unquantised)
export interface ParamPoint { t: P; h: P; c: P; e: P; d: P; w: P; offset: number; biome: string }

const span = (a: P, b: P): P => [a[0], b[1]];
const pt = (v: number): P => [v, v];
const FULL: P = [-1, 1];

const TEMPS: P[] = [[-1, -0.45], [-0.45, -0.15], [-0.15, 0.2], [0.2, 0.55], [0.55, 1]];
const HUMS: P[] = [[-1, -0.35], [-0.35, -0.1], [-0.1, 0.1], [0.1, 0.3], [0.3, 1]];
const ERO: P[] = [[-1, -0.78], [-0.78, -0.375], [-0.375, -0.2225], [-0.2225, 0.05], [0.05, 0.45], [0.45, 0.55], [0.55, 1]];
const FROZEN = TEMPS[0], UNFROZEN: P = [-0.45, 1];
const MUSHROOM: P = [-1.2, -1.05], DEEP_OCEAN: P = [-1.05, -0.455], OCEAN: P = [-0.455, -0.19], COAST: P = [-0.19, -0.11];
const INLAND: P = [-0.11, 0.55], NEAR: P = [-0.11, 0.03], MID: P = [0.03, 0.3], FAR: P = [0.3, 1];

type N = string | null;
const OCEANS: string[][] = [
  ['deep_frozen_ocean', 'deep_cold_ocean', 'deep_ocean', 'deep_lukewarm_ocean', 'warm_ocean'],
  ['frozen_ocean', 'cold_ocean', 'ocean', 'lukewarm_ocean', 'warm_ocean'],
];
const MIDDLE: string[][] = [
  ['snowy_plains', 'snowy_plains', 'snowy_plains', 'snowy_taiga', 'taiga'],
  ['plains', 'plains', 'forest', 'taiga', 'old_growth_spruce_taiga'],
  ['flower_forest', 'plains', 'forest', 'birch_forest', 'dark_forest'],
  ['savanna', 'savanna', 'forest', 'jungle', 'jungle'],
  ['desert', 'desert', 'desert', 'desert', 'desert'],
];
const MIDDLE_V: N[][] = [
  ['ice_spikes', null, 'snowy_taiga', null, null],
  [null, null, 'dappled_forest', null, 'old_growth_pine_taiga'],
  ['sunflower_plains', null, null, 'old_growth_birch_forest', null],
  [null, null, 'plains', 'sparse_jungle', 'bamboo_jungle'],
  [null, null, null, null, null],
];
const PLATEAU: string[][] = [
  ['snowy_plains', 'snowy_plains', 'snowy_plains', 'snowy_taiga', 'snowy_taiga'],
  ['meadow', 'meadow', 'forest', 'taiga', 'old_growth_spruce_taiga'],
  ['meadow', 'meadow', 'meadow', 'meadow', 'dark_forest'],
  ['savanna_plateau', 'savanna_plateau', 'forest', 'forest', 'jungle'],
  ['badlands', 'badlands', 'badlands', 'wooded_badlands', 'wooded_badlands'],
];
const PLATEAU_V: N[][] = [
  ['ice_spikes', null, null, null, null],
  ['cherry_grove', null, 'meadow', 'meadow', 'old_growth_pine_taiga'],
  ['cherry_grove', 'cherry_grove', 'forest', 'birch_forest', 'pale_garden'],
  [null, null, null, null, null],
  ['eroded_badlands', 'eroded_badlands', null, null, null],
];
const SHATTERED: N[][] = [
  ['windswept_gravelly_hills', 'windswept_gravelly_hills', 'windswept_hills', 'windswept_forest', 'windswept_forest'],
  ['windswept_gravelly_hills', 'windswept_gravelly_hills', 'windswept_hills', 'windswept_forest', 'windswept_forest'],
  ['windswept_hills', 'windswept_hills', 'windswept_hills', 'windswept_forest', 'windswept_forest'],
  [null, null, null, null, null],
  [null, null, null, null, null],
];

export function overworldParameters(): ParamPoint[] {
  const out: ParamPoint[] = [];
  const surface = (t: P, h: P, c: P, e: P, w: P, off: number, biome: string) => {
    out.push({ t, h, c, e, d: pt(0), w, offset: off, biome });
    out.push({ t, h, c, e, d: pt(1), w, offset: off, biome });
  };
  const under = (t: P, h: P, c: P, e: P, w: P, off: number, biome: string) => out.push({ t, h, c, e, d: [0.2, 0.9], w, offset: off, biome });
  const bottom = (t: P, h: P, c: P, e: P, w: P, off: number, biome: string) => out.push({ t, h, c, e, d: pt(1.1), w, offset: off, biome });

  const pickMiddle = (i: number, j: number, w: P) => (w[1] < 0 ? MIDDLE[i][j] : MIDDLE_V[i][j] ?? MIDDLE[i][j]);
  const pickBadlands = (j: number, w: P) => (j < 2 ? (w[1] < 0 ? 'badlands' : 'eroded_badlands') : j < 3 ? 'badlands' : 'wooded_badlands');
  const orBadlands = (i: number, j: number, w: P) => (i === 4 ? pickBadlands(j, w) : pickMiddle(i, j, w));
  const pickPlateau = (i: number, j: number, w: P) => (w[1] >= 0 && PLATEAU_V[i][j] ? PLATEAU_V[i][j]! : PLATEAU[i][j]);
  const pickSlope = (i: number, j: number, w: P) => (i >= 3 ? pickPlateau(i, j, w) : j <= 1 ? 'snowy_slopes' : 'grove');
  const orSlope = (i: number, j: number, w: P) => (i === 0 ? pickSlope(i, j, w) : orBadlands(i, j, w));
  const pickPeak = (i: number, j: number, w: P) => (i <= 2 ? (w[1] < 0 ? 'jagged_peaks' : 'frozen_peaks') : i === 3 ? 'stony_peaks' : pickBadlands(j, w));
  const pickShattered = (i: number, j: number, w: P) => SHATTERED[i][j] ?? pickMiddle(i, j, w);
  const windswept = (i: number, j: number, w: P, under0: string) => (i > 1 && j < 4 && w[1] >= 0 ? 'windswept_savanna' : under0);
  const pickBeach = (i: number) => (i === 0 ? 'snowy_beach' : i === 4 ? 'desert' : 'beach');
  const shatteredCoast = (i: number, j: number, w: P) => windswept(i, j, w, w[1] >= 0 ? pickMiddle(i, j, w) : pickBeach(i));

  // off-coast
  surface(FULL, FULL, MUSHROOM, FULL, FULL, 0, 'mushroom_fields');
  for (let i = 0; i < 5; i++) {
    surface(TEMPS[i], FULL, DEEP_OCEAN, FULL, FULL, 0, OCEANS[0][i]);
    surface(TEMPS[i], FULL, OCEAN, FULL, FULL, 0, OCEANS[1][i]);
  }

  const peaks = (w: P) => {
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
      const t = TEMPS[i], h = HUMS[j];
      const r0 = pickMiddle(i, j, w), r1 = orBadlands(i, j, w), r2 = orSlope(i, j, w), r3 = pickPlateau(i, j, w);
      const r4 = pickShattered(i, j, w), r5 = windswept(i, j, w, r4), r6 = pickPeak(i, j, w);
      surface(t, h, span(COAST, FAR), ERO[0], w, 0, r6);
      surface(t, h, span(COAST, NEAR), ERO[1], w, 0, r2);
      surface(t, h, span(MID, FAR), ERO[1], w, 0, r6);
      surface(t, h, span(COAST, NEAR), span(ERO[2], ERO[3]), w, 0, r0);
      surface(t, h, span(MID, FAR), ERO[2], w, 0, r3);
      surface(t, h, MID, ERO[3], w, 0, r1);
      surface(t, h, FAR, ERO[3], w, 0, r3);
      surface(t, h, span(COAST, FAR), ERO[4], w, 0, r0);
      surface(t, h, span(COAST, NEAR), ERO[5], w, 0, r5);
      surface(t, h, span(MID, FAR), ERO[5], w, 0, r4);
      surface(t, h, span(COAST, FAR), ERO[6], w, 0, r0);
    }
  };
  const high = (w: P) => {
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
      const t = TEMPS[i], h = HUMS[j];
      const r0 = pickMiddle(i, j, w), r1 = orBadlands(i, j, w), r2 = orSlope(i, j, w), r3 = pickPlateau(i, j, w);
      const r4 = pickShattered(i, j, w), r5 = windswept(i, j, w, r0), r6 = pickSlope(i, j, w), r7 = pickPeak(i, j, w);
      surface(t, h, COAST, span(ERO[0], ERO[1]), w, 0, r0);
      surface(t, h, NEAR, ERO[0], w, 0, r6);
      surface(t, h, span(MID, FAR), ERO[0], w, 0, r7);
      surface(t, h, NEAR, ERO[1], w, 0, r2);
      surface(t, h, span(MID, FAR), ERO[1], w, 0, r6);
      surface(t, h, span(COAST, NEAR), span(ERO[2], ERO[3]), w, 0, r0);
      surface(t, h, span(MID, FAR), ERO[2], w, 0, r3);
      surface(t, h, MID, ERO[3], w, 0, r1);
      surface(t, h, FAR, ERO[3], w, 0, r3);
      surface(t, h, span(COAST, FAR), ERO[4], w, 0, r0);
      surface(t, h, span(COAST, NEAR), ERO[5], w, 0, r5);
      surface(t, h, span(MID, FAR), ERO[5], w, 0, r4);
      surface(t, h, span(COAST, FAR), ERO[6], w, 0, r0);
    }
  };
  const swamps = (w: P, c: P) => {
    surface(span(TEMPS[1], TEMPS[2]), FULL, c, ERO[6], w, 0, 'swamp');
    surface(span(TEMPS[3], TEMPS[4]), FULL, c, ERO[6], w, 0, 'mangrove_swamp');
  };
  const mid = (w: P) => {
    surface(FULL, FULL, COAST, span(ERO[0], ERO[2]), w, 0, 'stony_shore');
    swamps(w, span(NEAR, FAR));
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
      const t = TEMPS[i], h = HUMS[j];
      const r0 = pickMiddle(i, j, w), r1 = orBadlands(i, j, w), r2 = orSlope(i, j, w), r3 = pickShattered(i, j, w);
      const r4 = pickPlateau(i, j, w), r5 = pickBeach(i), r6 = windswept(i, j, w, r0), r7 = shatteredCoast(i, j, w), r8 = pickSlope(i, j, w);
      surface(t, h, span(NEAR, FAR), ERO[0], w, 0, r8);
      surface(t, h, span(NEAR, MID), ERO[1], w, 0, r2);
      surface(t, h, FAR, ERO[1], w, 0, i === 0 ? r8 : r4);
      surface(t, h, NEAR, ERO[2], w, 0, r0);
      surface(t, h, MID, ERO[2], w, 0, r1);
      surface(t, h, FAR, ERO[2], w, 0, r4);
      surface(t, h, span(COAST, NEAR), ERO[3], w, 0, r0);
      surface(t, h, span(MID, FAR), ERO[3], w, 0, r1);
      if (w[1] < 0) { surface(t, h, COAST, ERO[4], w, 0, r5); surface(t, h, span(NEAR, FAR), ERO[4], w, 0, r0); }
      else surface(t, h, span(COAST, FAR), ERO[4], w, 0, r0);
      surface(t, h, COAST, ERO[5], w, 0, r7);
      surface(t, h, NEAR, ERO[5], w, 0, r6);
      surface(t, h, span(MID, FAR), ERO[5], w, 0, r3);
      surface(t, h, COAST, ERO[6], w, 0, w[1] < 0 ? r5 : r0);
      if (i === 0) surface(t, h, span(NEAR, FAR), ERO[6], w, 0, r0);
    }
  };
  const low = (w: P) => {
    surface(FULL, FULL, COAST, span(ERO[0], ERO[2]), w, 0, 'stony_shore');
    swamps(w, span(NEAR, FAR));
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
      const t = TEMPS[i], h = HUMS[j];
      const r0 = pickMiddle(i, j, w), r1 = orBadlands(i, j, w), r2 = orSlope(i, j, w), r3 = pickBeach(i), r4 = windswept(i, j, w, r0), r5 = shatteredCoast(i, j, w);
      surface(t, h, NEAR, span(ERO[0], ERO[1]), w, 0, r1);
      surface(t, h, span(MID, FAR), span(ERO[0], ERO[1]), w, 0, r2);
      surface(t, h, NEAR, span(ERO[2], ERO[3]), w, 0, r0);
      surface(t, h, span(MID, FAR), span(ERO[2], ERO[3]), w, 0, r1);
      surface(t, h, COAST, span(ERO[3], ERO[4]), w, 0, r3);
      surface(t, h, span(NEAR, FAR), ERO[4], w, 0, r0);
      surface(t, h, COAST, ERO[5], w, 0, r5);
      surface(t, h, NEAR, ERO[5], w, 0, r4);
      surface(t, h, span(MID, FAR), ERO[5], w, 0, r0);
      surface(t, h, COAST, ERO[6], w, 0, r3);
      if (i === 0) surface(t, h, span(NEAR, FAR), ERO[6], w, 0, r0);
    }
  };
  const valleys = (w: P) => {
    surface(FROZEN, FULL, COAST, span(ERO[0], ERO[1]), w, 0, w[1] < 0 ? 'stony_shore' : 'frozen_river');
    surface(UNFROZEN, FULL, COAST, span(ERO[0], ERO[1]), w, 0, w[1] < 0 ? 'stony_shore' : 'river');
    surface(FROZEN, FULL, NEAR, span(ERO[0], ERO[1]), w, 0, 'frozen_river');
    surface(UNFROZEN, FULL, NEAR, span(ERO[0], ERO[1]), w, 0, 'river');
    surface(FROZEN, FULL, span(COAST, FAR), span(ERO[2], ERO[5]), w, 0, 'frozen_river');
    surface(UNFROZEN, FULL, span(COAST, FAR), span(ERO[2], ERO[5]), w, 0, 'river');
    surface(FROZEN, FULL, COAST, ERO[6], w, 0, 'frozen_river');
    surface(UNFROZEN, FULL, COAST, ERO[6], w, 0, 'river');
    swamps(w, span(INLAND, FAR));
    surface(FROZEN, FULL, span(INLAND, FAR), ERO[6], w, 0, 'frozen_river');
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) surface(TEMPS[i], HUMS[j], span(MID, FAR), span(ERO[0], ERO[1]), w, 0, orBadlands(i, j, w));
  };

  mid([-1, -0.93333334]); high([-0.93333334, -0.7666667]); peaks([-0.7666667, -0.56666666]); high([-0.56666666, -0.4]);
  mid([-0.4, -0.26666668]); low([-0.26666668, -0.05]); valleys([-0.05, 0.05]); low([0.05, 0.26666668]);
  mid([0.26666668, 0.4]); high([0.4, 0.56666666]); peaks([0.56666666, 0.7666667]); high([0.7666667, 0.93333334]); mid([0.93333334, 1]);

  // underground
  under(FULL, FULL, [0.8, 1], FULL, FULL, 0, 'dripstone_caves');
  under(FULL, [0.7, 1], FULL, FULL, FULL, 0, 'lush_caves');
  under(FULL, [-1, -0.7], FULL, FULL, FULL, 0, 'sulfur_caves');
  bottom(FULL, FULL, FULL, span(ERO[0], ERO[1]), FULL, 0, 'deep_dark');
  return out;
}

/** MultiNoiseBiomeSourceParameterList.Preset.NETHER */
export function netherParameters(): ParamPoint[] {
  const z: P = [0, 0];
  const pt2 = (t: number, h: number, off: number, biome: string): ParamPoint => ({ t: [t, t], h: [h, h], c: z, e: z, d: z, w: z, offset: off, biome });
  return [pt2(0, 0, 0, 'nether_wastes'), pt2(0, -0.5, 0, 'soul_sand_valley'), pt2(0.4, 0, 0, 'crimson_forest'), pt2(0, 0.5, 0.375, 'warped_forest'), pt2(-0.5, 0, 0.175, 'basalt_deltas')];
}

const Q = (v: number) => Math.round(v * 10000); // Climate.quantizeCoord

interface QPoint { r: Int32Array; offset: number; biome: number }

export class MultiNoiseBiomeSource {
  /**
   * Column search. Every parameter point has one of a handful of depth ranges, and depth is the only
   * parameter that varies with y. So per column we find, for each depth-range group, the point with the
   * smallest distance over the other five parameters (lowest index on ties); a depth query is then the
   * best of those few candidates. Exactly equal to a full nearest-point scan, including tie-breaking.
   */
  column(t: number, h: number, c: number, e: number, w: number): (d: number) => number {
    const v = [Q(t), Q(h), Q(c), Q(e), 0, Q(w)];
    const groups = this.depthGroups();
    const best: { part: number; idx: number; lo: number; hi: number }[] = [];
    for (const g of groups) {
      let bp = Infinity, bi = -1;
      for (const i of g.members) {
        const p = this.points[i];
        let dist = p.offset * p.offset;
        for (let k = 0; k < 6; k++) {
          if (k === 4) continue;
          const lo = p.r[k * 2], hi = p.r[k * 2 + 1], x = v[k];
          const dd = x < lo ? lo - x : x > hi ? x - hi : 0;
          dist += dd * dd;
          if (dist > bp) break;
        }
        if (dist < bp || (dist === bp && i < bi)) { bp = dist; bi = i; }
      }
      if (bi >= 0) best.push({ part: bp, idx: bi, lo: g.lo, hi: g.hi });
    }
    return (d: number) => {
      const qd = Q(d);
      let bd = Infinity, bi = 0;
      for (const b of best) {
        const dd = qd < b.lo ? b.lo - qd : qd > b.hi ? qd - b.hi : 0;
        const dist = b.part + dd * dd;
        if (dist < bd || (dist === bd && b.idx < bi)) { bd = dist; bi = b.idx; }
      }
      return this.points[bi].biome;
    };
  }
  private groups: { lo: number; hi: number; members: number[] }[] | null = null;
  private depthGroups() {
    if (this.groups) return this.groups;
    const m = new Map<string, { lo: number; hi: number; members: number[] }>();
    this.points.forEach((p, i) => {
      const k = p.r[8] + ',' + p.r[9];
      let g = m.get(k);
      if (!g) { g = { lo: p.r[8], hi: p.r[9], members: [] }; m.set(k, g); }
      g.members.push(i);
    });
    return (this.groups = [...m.values()]);
  }

  private points: QPoint[];
  private lastIdx = 0;
  constructor(params: ParamPoint[], biomeId: (name: string) => number) {
    this.points = params.map((p) => ({
      r: Int32Array.from([p.t, p.h, p.c, p.e, p.d, p.w].flatMap((r) => [Q(r[0]), Q(r[1])])),
      offset: Q(p.offset), biome: biomeId(p.biome),
    }));
  }
  /** Climate.ParameterList.findValue: nearest point by squared parameter distance. */
  find(t: number, h: number, c: number, e: number, d: number, w: number): number {
    const v = [t, h, c, e, d, w].map(Q);
    let best = Infinity, bi = this.lastIdx;
    const check = (i: number) => {
      const p = this.points[i];
      let dist = p.offset * p.offset;
      for (let k = 0; k < 6 && dist <= best; k++) {
        const lo = p.r[k * 2], hi = p.r[k * 2 + 1], x = v[k];
        const dd = x < lo ? lo - x : x > hi ? x - hi : 0;
        dist += dd * dd;
      }
      // ties resolve to the lowest index so results never depend on lookup history
      if (dist < best || (dist === best && i < bi)) { best = dist; bi = i; }
    };
    check(this.lastIdx); // warm start (vanilla caches the last result too)
    for (let i = 0; i < this.points.length; i++) check(i);
    this.lastIdx = bi;
    return this.points[bi].biome;
  }
}
