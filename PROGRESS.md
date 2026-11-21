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

Remaining for Phase 2: WebGL2 layer (texture arrays + mip strategies, terrain shader port of
terrain.vsh/fsh + sampleNearest, lightmap.fsh port), timeline evaluator, sky/sun/moon/stars,
clouds, fog, optional shadow maps, test chunk scene + fly camera, screenshot.

