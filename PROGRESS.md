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

## Phase 4 — Physics, break/place, drops, survival stats — DONE (core)
* `game/entity.ts` Entity.move/collide port: Y-then-major-axis resolution, 0.6 step-up, sneak edge guard,
  block speed factors (soul sand/honey), fall distance; fluids (water/lava heights, eye-in-water).
* `game/player.ts` LivingEntity.travel constants: gravity 0.08, drag 0.98/0.91, friction-scaled ground
  speed 0.216/f^3, air speed 0.02/0.026, jump 0.42 (+0.2 sprint boost), sprint x1.3 with FOV kick,
  swimming, ladders, creative flight; FoodData (exhaustion/saturation/regen/starvation), air & drowning,
  fall damage, XP levels; view bobbing and hurt tilt.
* `game/blockprops.ts` hardness, collision shapes (model-derived; 1.5 fences/walls), friction, climbables.
* `game/items.ts` 26.3 item components: tool rules (speed/correct_for_drops via tags), stack sizes, food.
* `game/loot.ts` loot-table evaluation (pools, alternatives, conditions incl. match_tool/silk touch,
  table_bonus, survives_explosion; functions set_count/apply_bonus/limit_count/explosion_decay).
* `game/placement.ts` placement states (axis, facing rules per family, slabs incl. merging, stairs with
  shape, trapdoors, doors with hinge, beds, torches/signs/banners/heads wall variants, buttons/levers,
  waterlogging) and neighbour shape updates (fences, panes, walls, redstone wire, stairs, snowy grass).
* `game/game.ts` survival breaking with destroy_stage overlay, creative instant break, drops + ore XP,
  tool durability, placement collision check, doors/trapdoors/gates/levers, eating, item entities
  (physics, pickup, merging stacks into inventory), pick block, drop, bonus chest, furnaces ticking.

## Phase 5 — UI — DONE (core screens)
* `gui/renderer.ts` GuiGraphics: integer GUI scale (Window.calculateScale), nine-slice/tile/stretch
  sprites from the atlas metadata, logical-size blits, vanilla font (advances, shadow 25%, formatting
  codes, unifont fallback), pose stack.
* `gui/panorama.ts` 26.3 panorama cube (85 deg FOV, 0.1 deg/tick spin) + Gaussian menu blur.
* Screens: Mojang Studios LoadingOverlay, Title (logo, edition, rotating/pulsing splash from splashes.txt),
  Select World (search, list with icons/dates/mode, play/create/edit(duplicate)/delete/re-create),
  Create World (Game/World/More tabs, name/mode/difficulty/cheats, type/seed/structures/bonus chest,
  create disabled when name blank), terrain loading, Pause, Options, Video Settings, Music & Sounds,
  Death (hardcore variant), Confirm.
* HUD: hotbar + selection, offhand, inverted crosshair, hearts (blink, low-health shake, hardcore),
  food (saturation jitter), armour, air bubbles, XP bar + outlined level number, held item name fade,
  F3 debug screen.
* Containers: survival inventory (2x2 crafting, armour, offhand), crafting table (3x3), chest,
  furnace (fuel/cook progress), creative inventory with tabs, search and scrollbar. Click semantics:
  pickup/place/swap/split, drag-distribute, shift-click, number-key hotbar swap, double-click collect.
* Sound manager: sounds.json events, weighted variants, categories, block sound groups, menu/game music.
* Options and worlds persist (localStorage / IndexedDB); player, time and containers saved per world.

## Phase 6 — Mobs, particles, chat, effects — DONE (subset)
* `render/entitymodels.ts`: box-UV entity models (zombie, skeleton, creeper, pig, cow, sheep + wool,
  chicken, spider, arrow) with vanilla walk/attack/head animations; hurt tint, death tilt.
* `game/mobs.ts`: mob AI (wander, look, panic, melee, skeleton bow + arrows, creeper swell/explosion,
  spider climbing), A* pathfinding over walkable cells, natural spawning with light/height checks and
  mob caps, loot-table drops on death, knockback, combat with attack cooldown.
* `render/particles.ts`: block destroy/crack/terrain particles, explosion, spawn/poof, driven by
  particles.json sprite lists.
* Chat (T or /) with commands: /gamemode /time /tp /give /difficulty /gamerule /weather /kill /summon
  /seed /help; chat history fades on the HUD.
* Screen effects: vignette (brightness-tracked), underwater overlay.

## Phase 7 — Performance, culling, persistence — DONE (core)
* Frustum culling + vanilla-style section occlusion culling (VisGraph flood fill → 15 face-pair bits,
  BFS from the camera section through open faces).
* Light engine: batched section dirty flush and cached chunk lookup (64 → 25 ms/chunk).
* Optional sun/moon shadow map (Video Settings → Shadows, **off by default**): 2048² depth map,
  texel-snapped ortho cascade, 3×3 PCF, applied only to sky-lit surfaces (shots/shadows_1.png).
* Save/load of chunks, player, containers and options (IndexedDB + localStorage); autosave.
