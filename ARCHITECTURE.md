# Architecture

Browser reconstruction of Minecraft Java Edition **26.3** (Wilderness Bound). Single-player, local only,
no server.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | Type safety over a large codebase that mirrors Java class structure. |
| Bundler | Vite | Fast dev server, native ES module workers (`worker.format = 'es'`). |
| GPU | **Raw WebGL2**, no Three.js | See below. |
| Threads | Web Workers | World generation, lighting and chunk meshing run off the main thread. |
| Persistence | IndexedDB | World saves (region-like per-chunk records), options. |
| Audio | Web Audio API | Decodes the vanilla `.ogg` files; per-category gain nodes. |

### Why raw WebGL2 instead of Three.js

Vanilla's renderer is a small number of very specific pipelines: chunk sections drawn with a per-section
offset uniform, a 16x16 lightmap texture sampled per vertex, a packed vertex format, the custom
`sampleNearest` texel-snapping sampler, sky/stars/clouds with their own shaders. These map 1:1 onto
WebGL2 primitives. Three.js would sit between us and every one of them (its material system, its own
matrices and colour management, scene-graph traversal per draw) and we would end up writing custom
`ShaderMaterial`s for every pass anyway, while paying for per-object overhead on thousands of chunk
sections. Raw WebGL2 lets the GLSL stay a direct port of `assets/minecraft/shaders/core/*.{vsh,fsh}`
from 26.3 (copied for reference to `public/gen/shaders_vanilla_reference/`).

## Asset pipeline (`npm run assets`)

`scripts/fetch-assets.mjs` sparse-clones five pinned sources into `.cache/vanilla/` and **verifies the
exact commit hash** of each (the build refuses to run on anything else):

| Source | Ref | Provides |
|---|---|---|
| InventivetalentDev/minecraft-assets | `26.3` | textures, models, blockstates, items, font, lang, texts |
| misode/mcmeta | `26.3-assets` | sounds (.ogg, 4961 files), sounds.json, shaders, particles, atlases |
| misode/mcmeta | `26.3-data-json` | recipes, loot tables, tags, worldgen, enchantments, damage types |
| misode/mcmeta | `26.3-data` | structure templates (.nbt) |
| misode/mcmeta | `26.3-summary` | block property/default-state report, registries, item components |

`scripts/extract-assets.mjs` then builds `public/gen/` (gitignored, never committed — Mojang assets are
not redistributable in this repository):

* **Atlases** (`atlas/*.png` + `.json`), driven by the vanilla `atlases/*.json` source lists
  (`directory`, `single`, `paletted_permutations`):
  * `blocks` — every `block/` sprite, `entity/conduit/`, bell body, enchanting-table book, plus the
    code-generated `missingno`. Every animation frame is its own tile, 1px edge-extruded padding.
  * `items` — `item/`, the 64 armour-trim palette permutations, and block sprites used as
    `item/generated` layers.
  * `gui` — `gui/sprites/**` and `mob_effect/`, with each sprite's `gui.scaling` (nine_slice / tile /
    stretch) carried into the manifest. Never mipmapped.
  * `particles`, `celestials`, `paintings`, `map_decorations`.
  * Each sprite records its alpha class (solid / cutout / translucent), mipmap strategy
    (`mipmap_strategy`, `alpha_cutoff_bias` from 26.3 `.mcmeta`), and animation sequence
    (frame, ticks) + `interpolate` flag.
* **`blocks.json`** — all 1286 blocks in registry order (air = 0) with properties in vanilla
  `StateDefinition` order (sorted by name, last property fastest). All 35,723 states are pre-resolved
  against the blockstate file (`variants` key matching or `multipart` `when`/`OR`/`AND`), giving per
  state a list of *parts*, each a weighted list of `{model, x, y, z, uvlock}`.
* **`models.json`** — every model reachable from a blockstate or item definition, parent chain
  flattened, `#texture` slots resolved (including 26.3 `{sprite, force_translucent}` objects), default
  face UVs computed exactly as `BlockElement`, `cullface`, `tintindex`, `rotation` (axis/angle and 26.3
  Euler `x/y/z`), `shade`, `light_emission`, `shade_direction_override`. Per model: render layer and a
  `fullCube` occlusion flag.
* **`font.json`** — glyph metrics from the vanilla provider chain (`space`, `bitmap` with vanilla
  `getActualGlyphWidth` advance rule, `unihex` fallback baked to `font/unifont.png` for every codepoint
  used by en_us.json, splashes and credits).
* **`data/*.json`** — bundled recipes, loot tables, tags, worldgen JSON, enchantments, damage types.
* Byte-for-byte copies of `textures/`, `sounds/`, `lang/en_us.json`, `texts/`.

`npm test` re-reads every atlas and compares each frame row-by-row against the vanilla PNG.

## Runtime layout (`src/`)

```
src/
  main.ts                 boot: load bundle, create GL, enter title screen
  assets/                 typed loaders for public/gen (fail loudly on missing files)
  gl/                     WebGL2 helpers: shader compile, textures (array + 2D), buffers
  render/                 world renderer: chunk meshes, lightmap, sky, clouds, fog, particles, hand
  world/                  block registry, chunk storage (paletted sections), lighting engine
  worldgen/               noise router, biome source, surface rules, carvers, features, structures
  mesh/                   block model baking -> quads, greedy meshing, AO (worker)
  entity/                 player physics, mobs, AI, pathfinding
  gui/                    screens, widgets, font renderer, sprite renderer
  audio/                  sound manager
  save/                   IndexedDB world storage
```

### Block textures at runtime

The packed `blocks.png` atlas is loaded once; each sprite is uploaded into a layer of a
`TEXTURE_2D_ARRAY` (16x16 layers for the 16px sprites, a second array for the few larger sprites —
signs, shelves, flowing water/lava, straw bed) directly from the atlas with
`UNPACK_SKIP_PIXELS/ROWS/ROW_LENGTH`. This gives per-sprite mip chains with zero cross-sprite bleeding
and lets greedy-meshed quads repeat the texture with `fract()` in the shader. Animated sprites keep
their frames in CPU memory and the active frame is re-uploaded into the sprite's layer on the 20 tps
tick, the way vanilla's `SpriteContents.AnimatedTexture` uploads into the atlas.
