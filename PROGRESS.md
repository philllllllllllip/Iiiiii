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

## Next: Phase 2 — renderer (single chunk, atlas, AO, light, shadows, fog, sky)
