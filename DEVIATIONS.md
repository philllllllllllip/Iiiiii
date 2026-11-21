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
