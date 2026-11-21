# Progress

## Phase 1 — Scaffold, asset pipeline, atlas build, ARCHITECTURE.md — DONE

* Vite + TypeScript (strict) + Vitest scaffold; `npm run assets`, `dev`, `build`, `test`.
* `scripts/fetch-assets.mjs`: pinned, hash-verified sparse clones of the 26.3 sources.
* `scripts/extract-assets.mjs`: builds `public/gen/` in ~2 s after fetch.
  * blocks atlas: 1310 sprites / 1892 frames (2048x512); items 1009; gui 509; particles 300;
    celestials, paintings, map decorations.
  * 1286 blocks, 35,723 block states, 3949 baked models, 7662 model parts, 1658 item definitions.
  * font: 2431 glyphs; every codepoint in en_us.json, splashes and credits has a vanilla glyph.
  * Fails the build on any unresolved texture, model, blockstate variant or animation frame.
* `tests/atlas.test.ts`: byte-exact atlas verification, blockstate/model integrity, 26.3 content,
  font advance rules — 6/6 passing.

## Phase 2 — Renderer — IN PROGRESS

Done (typechecks; core logic is DOM-free so it can run in workers):
* `src/assets/png.ts` exact PNG decoder (no canvas premultiply loss); `bundle.ts` loader, fails loudly.
* `src/util/javarandom.ts` exact java.util.Random + Mth.getSeed (verified against real Java in tests).
* `src/util/simplex.ts` vanilla SimplexNoise (BIOME_INFO_NOISE for swamp grass).
* `src/world/registry.ts` block state ids/properties; `chunk.ts`, `world.ts` storage.
* `src/world/blockinfo.ts` emission table, lightBlock rules, shape face masks, tint providers, offsets.
* `src/world/light.ts` sky + block light BFS, cross-chunk seeding, incremental relight.
* `src/world/biomes.ts` biome colours from 26.3 biome JSON + colormaps (swamp/dark_forest modifiers).
* `src/mesh/bake.ts` FaceBakery port (vertex order, UV rotation, element/variant rotation, uvlock).
* `src/mesh/mesher.ts` smooth lighting/AO, culling, biome blend, exact-safe greedy merge, liquids.
* 26.3 timeline data (sky/fog/cloud/light colour keyframes) now bundled to `data/timelines.json`.

Renderer now running (shots/noon.png, sunset.png, midnight.png, headless Chromium):
* `src/render/blocktextures.ts` texture arrays from the atlas, 26.3 mip strategies, 20 tps animation.
* `src/render/terrain.ts` GLSL ES port of terrain.vsh/fsh + sampleNearest + sample_lightmap + fog;
  solid / cutout / sorted translucent passes.
* `src/render/lightmap.ts` exact lightmap.fsh port with block-light flicker.
* `src/env/timeline.ts` evaluates 26.3 timelines (wrap-around keyframes, cubic_bezier, modifiers).
* `src/render/sky.ts` sky disc, sunrise fan, sun, moon phases, 1500 stars (seed 10842), void disc.
* `src/render/clouds.ts` fancy clouds from clouds.png with depth pre-pass and drift.
* `src/demo/testscene.ts` 3x3-chunk test scene; 18 sections / 22.7k quads meshed in ~170 ms.

Remaining for Phase 2: sunrise-fan edge artifact, frustum culling, optional (default-off) shadow
maps, side-by-side comparison against a real 26.3 screenshot.

## Phase 3 — World generation + streaming — DONE (with listed gaps)

Driven by the 26.3 worldgen data pack (data/minecraft/worldgen), not a homemade generator:
* `worldgen/random.ts` Xoroshiro128++ / positional factories / MD5 `fromHashOf` — verified against Java.
* `worldgen/noise.ts` ImprovedNoise, PerlinNoise (modern + legacy), NormalNoise (26.3 param format), BlendedNoise.
* `worldgen/density.ts` interpreter for every density function type used by 26.3, incl. the new
  `interval_select`, `find_top_surface`, `gradient`, `div`, `range_choice`; cell interpolation + caches.
* `worldgen/biomesource.ts` multi-noise biome source (OverworldBiomeBuilder reconstruction, exact
  nearest-point search with an O(groups) column fast path).
* `worldgen/surface.ts` 26.3 `material_rule` interpreter incl. `ore_vein` rule and badlands bands.
* `worldgen/carvers.ts` cave + canyon carvers (legacy random seeding as vanilla).
* `worldgen/features.ts` placed/configured feature engine: all 18 placement modifiers, all block
  predicates and state providers present in 26.3, trees (10 trunk / 12 foliage placers, decorators),
  ores, patches, lakes, dungeons, springs, disks, mushrooms, bamboo, vines, glow lichen, ...
* `worldgen/structures.ts` structure sets (random_spread / concentric_rings), jigsaw assembly from
  template pools + .nbt templates with processors (villages, outposts, trail ruins, ancient cities,
  trial chambers, camps), ruined portals, shipwrecks, igloos, ocean ruins, buried treasure,
  mineshafts and strongholds (procedural, simplified).
* World types: normal, large biomes, amplified, single biome, superflat (flat presets from data).
* Streaming: world worker (store, light, mesh) + generation worker pool; deterministic,
  load-order-independent decoration (isolated decoration + canonical write order).
* Performance (Node, one core): proto ~50 ms/chunk, decoration ~80 ms/chunk.
* Tests: same seed -> identical chunks across fresh generators (`tests/worldgen.test.ts`);
  exact PNG decoding of all 3964 textures (`tests/png.test.ts`).
