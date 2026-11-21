# Deviations from vanilla 26.3

Every place this client knowingly differs from Minecraft Java Edition 26.3, and why.
Silence is a bug: if you find a difference not listed here, it is a defect.

## Asset sourcing
* **Mojang CDN not used.** `piston-meta.mojang.com` / `resources.download.minecraft.net` are blocked by
  this build environment's network policy. Assets come from two GitHub mirrors that extract the same
  files from the 26.3 client jar and asset index, pinned to exact commits (see ARCHITECTURE.md).
* **Assets are not committed.** Mojang's EULA does not allow redistributing game assets, so
  `public/gen/` is gitignored and must be produced with `npm run assets`.

## Rendering
* **Block texture storage.** Vanilla samples one 2D block atlas. We upload each atlas sprite into a
  texture-array layer (sourced from the packed atlas) so greedy-meshed faces can wrap inside one tile.
  Sampling uses a port of vanilla's `sampleNearest` texel-snapping, so magnified output is identical;
  at minified distances our per-sprite mip chains have no atlas-neighbour bleeding, which vanilla can
  show faintly.
* **Mipmap strategies.** 26.3 `.mcmeta` files declare `mipmap_strategy` (`mean`, `cutout`,
  `strict_cutout`, `dark_cutout`) and `alpha_cutoff_bias`. These are honoured, but the exact
  reduction kernels live in client code that is not part of the asset dump; ours are reconstructions.
* **Render layer assignment** is derived from sprite transparency (solid / cutout / translucent) and
  `force_translucent`, which is how current vanilla assigns `ChunkSectionLayer` from sprite contents.
* **Environment attribute defaults.** 26.3 makes sky/fog/light colours data-driven (timelines +
  dimension/biome attributes, all honoured), but each attribute's *default* value lives in code.
  Reconstructed defaults are in `src/env/timeline.ts` `ATTRIBUTE_DEFAULTS` (notably
  `block_light_tint #ffd88c`, `sky_fog_end_distance 512`, `cloud_fog_end_distance 2048`).
* **Atmospheric (environmental) fog is disabled in clear overworld air**; only render-distance fog
  applies. The exact AtmosphericFogEnvironment start/end formula is not in the asset dump.
* **Translucent terrain does not write depth** (per this project's spec); vanilla writes depth for
  the translucent chunk layer. Quads are sorted back-to-front per section, so visual difference is
  limited to particles/clouds behind water.
* **Sun shadow maps**: vanilla Java has none. They will ship as an option defaulting to OFF so the
  default render matches vanilla. (Not implemented yet.)
* **uvlock** recomputes UVs by projecting world positions with the default face UV convention;
  exact for full faces, an approximation for faces with custom UVs.
* **Smooth-lighting corner "open" test** checks the side neighbour in the sampled layer; vanilla's
  exact neighbour offset for this test could not be verified from assets.
* **Emissive rendering** (`emissiveRendering` full-bright states) is not tabled yet.

## World generation
* **Not bit-identical to real Minecraft for the same seed.** Determinism across our own reloads is
  exact, but several pieces live in game code and are reconstructed: the OverworldBiomeBuilder
  parameter table, the meaning of 26.3's new noise `base_amplitude` (used as the NormalNoise value
  factor), aquifer internals (simplified nearest-cell fluid levels, no barriers), ore-vein internals,
  feature ordering (FeatureSorter replaced by first-appearance order), and many feature algorithms.
* **New 26.3 biomes**: `dappled_forest` placed as the variant of temperate/neutral-humidity forest,
  `sulfur_caves` as dry (humidity < -0.7) underground; their real placement is in code.
* **Decoration isolation**: each chunk's features are generated against undecorated neighbours and
  merged in canonical order (to be load-order independent). Vanilla features can see neighbours'
  already-placed features; ours cannot, so e.g. trees from adjacent chunks may overlap.
* **Not implemented feature types** (skipped): geode, fossil, large_dripstone, speleothem_cluster,
  root_system, iceberg, blue_ice, underwater_magma, spike, overlay, random_neighbor_spread,
  bonus_chest, nether/end features; tree decorators pale_moss, creaking_heart, shelf_mushroom.
* **Not implemented structures**: desert pyramid, jungle temple, swamp hut, ocean monument,
  woodland mansion (all code-built in vanilla). Mineshafts and strongholds are simplified procedural
  versions; stronghold placement ignores preferred biomes. Jigsaw terrain adaptation (beardifier) is
  not applied, entities in templates (villagers etc.) are not spawned.
* **Spawn point**: nearest dry, non-ocean column spiralling from 0,0 (vanilla uses spawn_target
  climate search).

## Known defects (to fix, not intended deviations)
* Sunset/sunrise fan shows hard wedge edges against the sky disc (see shots/sunset.png).
* No frustum culling yet; all loaded sections are drawn.
