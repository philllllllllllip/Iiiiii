// Builds the runtime asset bundle in public/gen from the pinned vanilla 26.3 sources.
//
//   public/gen/atlas/blocks.png  + blocks.json   packed block sprites (every animation frame), 1px extruded padding
//   public/gen/atlas/items.png   + items.json    item sprites (+ trim permutations, + block sprites used as item layers)
//   public/gen/atlas/gui.png     + gui.json      gui/sprites + mob_effect, with nine-slice / tile / stretch scaling
//   public/gen/atlas/particles.png + particles.json
//   public/gen/blocks.json       registry: every block, its properties, every state -> model parts, layers, flags
//   public/gen/models.json       every baked model referenced by a blockstate or item definition
//   public/gen/items.json        item definitions (items/*.json) + components summary
//   public/gen/font.json         glyph metrics from the vanilla providers (+ baked unifont fallback sheet)
//   public/gen/data/*.json       recipes, loot tables, tags, worldgen, registries
//   public/gen/textures/**, sounds/**, lang/en_us.json, texts/**   byte-for-byte copies of the vanilla files
//
// Any reference to a missing texture/model aborts the build. There are no placeholder fallbacks.
import fs from 'node:fs';
import path from 'node:path';
import { fetchAll } from './fetch-assets.mjs';
import { readPng, writePng, createImage, blitPadded, alphaClass, shelfPack } from './lib/png.mjs';
import { ModelStore, resolveTexture, defaultUv, DIRS, variantMatches, whenMatches, enumerateStates, stripNs } from './lib/models.mjs';
import { buildFont } from './lib/font.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'public', 'gen');
const t0 = Date.now();

const CACHE = process.argv.includes('--offline') ? path.join(ROOT, '.cache', 'vanilla') : fetchAll();
const MC = path.join(CACHE, 'textures', 'assets', 'minecraft');
const MC2 = path.join(CACHE, 'assets', 'assets', 'minecraft');
const DATA = path.join(CACHE, 'data', 'data', 'minecraft');
const SUM = path.join(CACHE, 'summary');
const TEX = path.join(MC, 'textures');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, j) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(j)); };
const log = (...a) => console.log('[extract]', ...a);
const errors = [];
const fail = (msg) => { errors.push(msg); };
const warnings = [];

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) throw new Error(`asset directory missing: ${dir}`);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

function copyTree(src, dst, filter = () => true, link = false) {
  let n = 0;
  for (const rel of walk(src)) {
    if (!filter(rel)) continue;
    const d = path.join(dst, rel);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    if (fs.existsSync(d)) fs.rmSync(d);
    if (link) { try { fs.linkSync(path.join(src, rel), d); n++; continue; } catch { /* cross-device: copy */ } }
    fs.copyFileSync(path.join(src, rel), d);
    n++;
  }
  return n;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'atlas'), { recursive: true });

// ---------------------------------------------------------------------------------------------
// 1. Byte-for-byte copies
// ---------------------------------------------------------------------------------------------
const skipMeta = (rel) => !rel.startsWith('_') && !rel.endsWith('/_list.json') && !rel.endsWith('/_all.json');
log('copied textures:', copyTree(TEX, path.join(OUT, 'textures'), skipMeta, true));
log('copied sounds:', copyTree(path.join(MC2, 'sounds'), path.join(OUT, 'sounds'), () => true, true));
fs.copyFileSync(path.join(MC2, 'sounds.json'), path.join(OUT, 'sounds.json'));
fs.mkdirSync(path.join(OUT, 'lang'), { recursive: true });
fs.copyFileSync(path.join(MC, 'lang', 'en_us.json'), path.join(OUT, 'lang', 'en_us.json'));
copyTree(path.join(MC, 'texts'), path.join(OUT, 'texts'), skipMeta);
copyTree(path.join(MC2, 'shaders'), path.join(OUT, 'shaders_vanilla_reference'), () => true);

// ---------------------------------------------------------------------------------------------
// 2. Sprite loading with .mcmeta (animation, texture mipmap strategy, gui scaling)
// ---------------------------------------------------------------------------------------------
function loadSprite(name, file) {
  const img = readPng(file);
  const metaFile = file + '.mcmeta';
  const meta = fs.existsSync(metaFile) ? readJson(metaFile) : {};
  const anim = meta.animation;
  let fw = img.width, fh = img.height;
  if (anim) {
    if (anim.width || anim.height) { fw = anim.width ?? img.width; fh = anim.height ?? img.height; }
    else { fw = fh = Math.min(img.width, img.height); }
  }
  const cols = Math.floor(img.width / fw), rows = Math.floor(img.height / fh);
  const frameCount = cols * rows;
  let seq = null;
  if (anim) {
    const ft = anim.frametime ?? 1;
    const frames = anim.frames ?? [...Array(frameCount).keys()];
    seq = frames.map((f) => (typeof f === 'number' ? [f, ft] : [f.index, f.time ?? ft]));
    for (const [i] of seq) if (i >= frameCount) fail(`sprite ${name}: animation frame ${i} out of range (${frameCount})`);
  }
  const usedFrames = seq ? [...new Set(seq.map((s) => s[0]))].sort((a, b) => a - b) : [0];
  let alpha = 'solid';
  const rank = { solid: 0, cutout: 1, translucent: 2 };
  for (const f of usedFrames) {
    const c = alphaClass(img, (f % cols) * fw, Math.floor(f / cols) * fh, fw, fh);
    if (rank[c] > rank[alpha]) alpha = c;
  }
  return {
    name, img, fw, fh, cols, usedFrames, seq,
    interpolate: !!(anim && anim.interpolate),
    alpha,
    mipmap: meta.texture?.mipmap_strategy ?? 'auto',
    alphaCutoffBias: meta.texture?.alpha_cutoff_bias ?? 0,
    gui: meta.gui?.scaling ?? null,
  };
}

/** Pack sprites into one atlas PNG; returns manifest {width,height,sprites:{name:{w,h,frames:[[x,y]],anim,...}}}. */
function buildAtlas(outName, sprites, maxWidth) {
  const items = [];
  for (const s of sprites) for (const f of s.usedFrames) items.push({ key: s.name + '#' + f, w: s.fw, h: s.fh });
  const pack = shelfPack(items, maxWidth, 1);
  const atlas = createImage(pack.width, pack.height);
  const manifest = { width: pack.width, height: pack.height, padding: 1, sprites: {} };
  for (const s of sprites) {
    const frames = {};
    for (const f of s.usedFrames) {
      const r = pack.rects.get(s.name + '#' + f);
      blitPadded(s.img, (f % s.cols) * s.fw, Math.floor(f / s.cols) * s.fh, s.fw, s.fh, atlas, r.x, r.y);
      frames[f] = [r.x + 1, r.y + 1];
    }
    const entry = { w: s.fw, h: s.fh, alpha: s.alpha };
    if (s.seq) {
      entry.frames = s.usedFrames.map((f) => frames[f]);
      const idx = new Map(s.usedFrames.map((f, i) => [f, i]));
      entry.anim = { seq: s.seq.map(([f, t]) => [idx.get(f), t]), interpolate: s.interpolate };
    } else {
      entry.frames = [frames[0]];
    }
    if (s.mipmap !== 'auto') entry.mipmap = s.mipmap;
    if (s.alphaCutoffBias) entry.alphaCutoffBias = s.alphaCutoffBias;
    if (s.gui) entry.gui = s.gui;
    manifest.sprites[s.name] = entry;
  }
  writePng(path.join(OUT, 'atlas', outName + '.png'), atlas);
  writeJson(path.join(OUT, 'atlas', outName + '.json'), manifest);
  log(`atlas ${outName}: ${sprites.length} sprites, ${items.length} frames, ${pack.width}x${pack.height}`);
  return manifest;
}

/** Evaluate an atlas source list (atlases/*.json): directory / single / paletted_permutations. */
function atlasSources(def) {
  const out = new Map();
  for (const src of def.sources) {
    const type = stripNs(src.type);
    if (type === 'directory') {
      const dir = path.join(TEX, src.source);
      for (const rel of walk(dir)) {
        if (!rel.endsWith('.png')) continue;
        const name = src.prefix + rel.slice(0, -4);
        out.set(name, path.join(dir, rel));
      }
    } else if (type === 'single') {
      const r = stripNs(src.resource);
      out.set(src.sprite ? stripNs(src.sprite) : r, path.join(TEX, r + '.png'));
    } else if (type === 'paletted_permutations') {
      out.set('__paletted__' + out.size, src);
    } else {
      throw new Error(`unsupported atlas source type ${src.type}`);
    }
  }
  return out;
}

/** Vanilla PalettedPermutations: remap each pixel whose RGB matches the key palette to the permutation palette. */
function palettedSprites(src) {
  const key = readPng(path.join(TEX, 'palettes', stripNs(src.palette_key) + '.png'));
  const res = [];
  for (const tex of src.textures) {
    const base = readPng(path.join(TEX, stripNs(tex) + '.png'));
    for (const [suffix, pal] of Object.entries(src.permutations)) {
      const p = readPng(path.join(TEX, 'palettes', stripNs(pal) + '.png'));
      if (p.width * p.height !== key.width * key.height) throw new Error(`palette ${pal} size mismatch`);
      const map = new Map();
      for (let i = 0; i < key.width * key.height; i++) {
        const k = key.data.readUInt32BE(i * 4) >>> 8;
        map.set(k, i);
      }
      const img = createImage(base.width, base.height);
      for (let i = 0; i < base.width * base.height; i++) {
        const a = base.data[i * 4 + 3];
        if (a === 0) continue;
        const k = base.data.readUInt32BE(i * 4) >>> 8;
        const pi = map.get(k);
        if (pi === undefined) { base.data.copy(img.data, i * 4, i * 4, i * 4 + 4); continue; }
        img.data[i * 4] = p.data[pi * 4]; img.data[i * 4 + 1] = p.data[pi * 4 + 1]; img.data[i * 4 + 2] = p.data[pi * 4 + 2];
        img.data[i * 4 + 3] = Math.round((a * p.data[pi * 4 + 3]) / 255);
      }
      const name = stripNs(tex) + '_' + suffix;
      res.push({ name, img, fw: img.width, fh: img.height, cols: 1, usedFrames: [0], seq: null, interpolate: false,
        alpha: alphaClass(img, 0, 0, img.width, img.height), mipmap: 'auto', alphaCutoffBias: 0, gui: null });
    }
  }
  return res;
}

function spritesFromAtlasDef(file, extra = new Map()) {
  const src = atlasSources(readJson(file));
  const sprites = [];
  for (const [name, f] of src) {
    if (name.startsWith('__paletted__')) sprites.push(...palettedSprites(f));
    else sprites.push(loadSprite(name, f));
  }
  for (const [name, f] of extra) if (!src.has(name)) sprites.push(loadSprite(name, f));
  return sprites;
}

// ---------------------------------------------------------------------------------------------
// 3. Block registry, blockstates, models
// ---------------------------------------------------------------------------------------------
/** MissingTextureAtlasSprite: 16x16, magenta (#F800F8) / black 8x8 checker. Generated in code by vanilla. */
function missingSprite() {
  const img = createImage(16, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const o = (y * 16 + x) * 4;
    const m = (x < 8) !== (y < 8);
    img.data[o] = m ? 0 : 0xf8; img.data[o + 1] = 0; img.data[o + 2] = m ? 0 : 0xf8; img.data[o + 3] = 255;
  }
  return { name: 'missingno', img, fw: 16, fh: 16, cols: 1, usedFrames: [0], seq: null, interpolate: false, alpha: 'solid', mipmap: 'auto', alphaCutoffBias: 0, gui: null };
}
const blockSprites = [...spritesFromAtlasDef(path.join(MC2, 'atlases', 'blocks.json')), missingSprite()];
const blockSpriteSet = new Map(blockSprites.map((s) => [s.name, s]));

const summaryBlocks = readJson(path.join(SUM, 'blocks', 'data.min.json'));
const registries = readJson(path.join(SUM, 'registries', 'data.min.json'));
const blockNames = ['air', ...registries.block.filter((b) => b !== 'air')];
const store = new ModelStore(path.join(MC, 'models'));

const spriteNames = [];
const spriteIndex = new Map();
const spriteId = (name) => {
  if (!spriteIndex.has(name)) { spriteIndex.set(name, spriteNames.length); spriteNames.push(name); }
  return spriteIndex.get(name);
};
const models = [];
const modelIndex = new Map();
const itemLayerBlockSprites = new Map();

function bakeModel(id) {
  id = stripNs(id);
  if (modelIndex.has(id)) return modelIndex.get(id);
  const m = store.resolve(id);
  const out = { id, ao: m.ao, gui: m.guiLight, elements: [] };
  if (Object.keys(m.display).length) out.display = m.display;
  if (m.generated) {
    out.layers = [];
    for (let i = 0; ; i++) {
      if (!(('layer' + i) in m.textures)) break;
      const t = resolveTexture(m.textures, '#layer' + i);
      if (!t) { fail(`model ${id}: unresolved layer${i}`); break; }
      if (t.sprite.startsWith('block/')) {
        if (!blockSpriteSet.has(t.sprite)) fail(`model ${id}: missing sprite ${t.sprite}`);
        itemLayerBlockSprites.set(t.sprite, path.join(TEX, t.sprite + '.png'));
      }
      out.layers.push(spriteId(t.sprite));
    }
  }
  let layer = 0; // 0 solid 1 cutout 2 translucent
  let full = m.elements.length === 1;
  for (const el of m.elements) {
    const e = { from: el.from, to: el.to, faces: {} };
    if (el.rotation) e.rotation = el.rotation;
    if (el.shade === false) e.shade = false;
    if (el.light_emission) e.light = el.light_emission;
    if (el.shade_direction_override) e.shadeDir = el.shade_direction_override;
    const isFull = el.from.every((v) => v === 0) && el.to.every((v) => v === 16) && !el.rotation;
    if (!isFull) full = false;
    for (const dir of DIRS) {
      const f = el.faces[dir];
      if (!f) { full = false; continue; }
      // Vanilla BlockElementFace: a face texture is always a slot reference; the leading '#' is optional.
      const ref = f.texture.startsWith('#') ? f.texture : '#' + f.texture;
      const t = resolveTexture(m.textures, ref);
      if (!t) { fail(`model ${id}: unresolved texture ${f.texture} on ${dir}`); continue; }
      const face = { uv: f.uv ?? defaultUv(dir, el.from, el.to), tex: spriteId(t.sprite) };
      if (f.cullface) face.cull = f.cullface === 'bottom' ? 'down' : f.cullface;
      else full = false;
      if (f.rotation) face.rot = f.rotation;
      if (f.tintindex !== undefined && f.tintindex !== -1) face.tint = f.tintindex;
      const sp = blockSpriteSet.get(t.sprite);
      let cls = sp ? sp.alpha : 'solid';
      if (t.forceTranslucent) { face.translucent = true; cls = 'translucent'; }
      const r = { solid: 0, cutout: 1, translucent: 2 }[cls];
      layer = Math.max(layer, r);
      e.faces[dir] = face;
    }
    out.elements.push(e);
  }
  const pt = m.textures.particle ? resolveTexture(m.textures, '#particle') : null;
  if (pt) {
    // Vanilla falls back to the missing sprite for an unresolvable particle texture (e.g. heavy_core's "all").
    const exists = blockSpriteSet.has(pt.sprite) || fs.existsSync(path.join(TEX, pt.sprite + '.png'));
    if (!exists && pt.sprite !== 'missingno') warnings.push(`model ${id}: particle sprite ${pt.sprite} does not exist -> missingno (vanilla behaviour)`);
    out.particle = spriteId(exists ? pt.sprite : 'missingno');
  }
  out.layer = layer;
  out.fullCube = full && layer === 0;
  const idx = models.length;
  modelIndex.set(id, idx);
  models.push(out);
  return idx;
}

const parts = [];
const partIndex = new Map();
function internPart(choices) {
  const key = JSON.stringify(choices);
  if (!partIndex.has(key)) { partIndex.set(key, parts.length); parts.push(choices); }
  return partIndex.get(key);
}
function choicesFrom(apply) {
  const arr = Array.isArray(apply) ? apply : [apply];
  return arr.map((a) => {
    const c = { m: bakeModel(a.model) };
    if (a.x) c.x = a.x;
    if (a.y) c.y = a.y;
    if (a.z) c.z = a.z;
    if (a.uvlock) c.uvlock = true;
    if (a.weight !== undefined && a.weight !== 1) c.w = a.weight;
    return c;
  });
}

const blocksOut = [];
const stateParts = []; // per global state id: array of part ids
let stateCount = 0;
for (const name of blockNames) {
  const sum = summaryBlocks[name];
  if (!sum) { fail(`block ${name} missing from summary`); continue; }
  const [props, defaults] = sum;
  const { names, states } = enumerateStates(props);
  const bsFile = path.join(MC, 'blockstates', name + '.json');
  if (!fs.existsSync(bsFile)) { fail(`block ${name}: no blockstate definition`); continue; }
  const bs = readJson(bsFile);
  const first = stateCount;
  let defaultState = first;
  states.forEach((st, i) => {
    const sp = [];
    if (bs.variants) {
      const key = Object.keys(bs.variants).find((k) => variantMatches(k, st));
      if (key === undefined) fail(`block ${name}: no variant for ${JSON.stringify(st)}`);
      else sp.push(internPart(choicesFrom(bs.variants[key])));
    } else if (bs.multipart) {
      for (const p of bs.multipart) if (whenMatches(p.when, st)) sp.push(internPart(choicesFrom(p.apply)));
    }
    stateParts.push(sp);
    if (names.every((n) => defaults[n] === st[n])) defaultState = first + i;
  });
  blocksOut.push({ name, props: names.map((n) => [n, props[n]]), first, count: states.length, def: defaultState });
  stateCount += states.length;
}
log(`blocks: ${blocksOut.length}, states: ${stateCount}, models (block): ${models.length}, parts: ${parts.length}`);

// ---------------------------------------------------------------------------------------------
// 4. Items: item definitions -> models
// ---------------------------------------------------------------------------------------------
const itemDefs = {};
function walkItemModel(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(walkItemModel); return; }
  if ((node.type === 'minecraft:model' || node.type === 'model') && typeof node.model === 'string') {
    node.modelIndex = bakeModel(node.model);
  }
  for (const [k, v] of Object.entries(node)) if (k !== 'modelIndex' && typeof v === 'object') walkItemModel(v);
}
for (const item of registries.item) {
  const f = path.join(MC, 'items', item + '.json');
  if (!fs.existsSync(f)) { if (item !== 'air') fail(`item ${item}: no item definition`); continue; }
  const def = readJson(f);
  walkItemModel(def.model);
  itemDefs[item] = def;
}
const itemComponents = readJson(path.join(SUM, 'item_components', 'data.min.json'));
log(`items: ${Object.keys(itemDefs).length}, models total: ${models.length}`);

// ---------------------------------------------------------------------------------------------
// 5. Atlases
// ---------------------------------------------------------------------------------------------
const blockAtlas = buildAtlas('blocks', blockSprites, 2048);
const itemSprites = spritesFromAtlasDef(path.join(MC2, 'atlases', 'items.json'), itemLayerBlockSprites);
// Element models may sample item/ sprites too: make sure every referenced non-block sprite is in the item atlas.
const itemSet = new Set(itemSprites.map((s) => s.name));
for (const name of spriteNames) {
  if (!blockSpriteSet.has(name) && !itemSet.has(name)) {
    const f = path.join(TEX, name + '.png');
    if (fs.existsSync(f)) { itemSprites.push(loadSprite(name, f)); itemSet.add(name); }
  }
}
const itemAtlas = buildAtlas('items', itemSprites, 2048);
const guiAtlas = buildAtlas('gui', spritesFromAtlasDef(path.join(MC2, 'atlases', 'gui.json')), 2048);
const particleAtlas = buildAtlas('particles', spritesFromAtlasDef(path.join(MC2, 'atlases', 'particles.json')), 1024);
buildAtlas('celestials', spritesFromAtlasDef(path.join(MC2, 'atlases', 'celestials.json')), 1024);
buildAtlas('paintings', spritesFromAtlasDef(path.join(MC2, 'atlases', 'paintings.json')), 1024);
buildAtlas('map_decorations', spritesFromAtlasDef(path.join(MC2, 'atlases', 'map_decorations.json')), 512);

for (const name of spriteNames) {
  if (!(name in blockAtlas.sprites) && !(name in itemAtlas.sprites)) fail(`sprite ${name} not placed in any atlas`);
}

// Particle definitions (particles/*.json) -> sprite lists; verify every sprite exists.
const particleDefs = {};
for (const rel of walk(path.join(MC2, 'particles'))) {
  if (!rel.endsWith('.json')) continue;
  const j = readJson(path.join(MC2, 'particles', rel));
  const tex = (j.textures || []).map(stripNs).map((t) => t.replace(/^particle\//, ''));
  for (const t of tex) if (!(t in particleAtlas.sprites)) fail(`particle ${rel}: sprite ${t} missing`);
  particleDefs[rel.slice(0, -5)] = tex;
}

// ---------------------------------------------------------------------------------------------
// 6. Font
// ---------------------------------------------------------------------------------------------
const lang = readJson(path.join(MC, 'lang', 'en_us.json'));
const splashes = fs.readFileSync(path.join(MC, 'texts', 'splashes.txt'), 'utf8');
const neededText = Object.values(lang).join('') + splashes + fs.readFileSync(path.join(MC, 'texts', 'end.txt'), 'utf8')
  + fs.readFileSync(path.join(MC, 'texts', 'postcredits.txt'), 'utf8') + JSON.stringify(readJson(path.join(MC, 'texts', 'credits.json')));
const font = buildFont({ texDir: TEX, fontDir: path.join(MC, 'font'), outDir: OUT, neededText });
log(`font: ${Object.keys(font.glyphs).length} glyphs, ${font.missingCount} codepoints without any glyph (rendered as vanilla missing-glyph box)`);
writeJson(path.join(OUT, 'font.json'), { sheets: font.sheets, glyphs: font.glyphs });

// ---------------------------------------------------------------------------------------------
// 7. Data bundles
// ---------------------------------------------------------------------------------------------
function bundle(dir, filter = () => true) {
  const out = {};
  for (const rel of walk(dir)) {
    if (!rel.endsWith('.json') || !filter(rel)) continue;
    out[rel.slice(0, -5)] = readJson(path.join(dir, rel));
  }
  return out;
}
writeJson(path.join(OUT, 'data', 'recipes.json'), bundle(path.join(DATA, 'recipe')));
writeJson(path.join(OUT, 'data', 'loot_tables.json'), bundle(path.join(DATA, 'loot_table')));
writeJson(path.join(OUT, 'data', 'tags.json'), bundle(path.join(DATA, 'tags')));
writeJson(path.join(OUT, 'data', 'worldgen.json'), bundle(path.join(DATA, 'worldgen')));
writeJson(path.join(OUT, 'data', 'enchantments.json'), bundle(path.join(DATA, 'enchantment')));
writeJson(path.join(OUT, 'data', 'damage_types.json'), bundle(path.join(DATA, 'damage_type')));
writeJson(path.join(OUT, 'data', 'painting_variants.json'), bundle(path.join(DATA, 'painting_variant')));
writeJson(path.join(OUT, 'data', 'timelines.json'), { timeline: bundle(path.join(DATA, 'timeline')), world_clock: bundle(path.join(DATA, 'world_clock')), tags: bundle(path.join(DATA, 'tags', 'timeline')) });
writeJson(path.join(OUT, 'data', 'dimension_types.json'), bundle(path.join(DATA, 'dimension_type')));
writeJson(path.join(OUT, 'data', 'registries.json'), registries);
copyTree(path.join(CACHE, 'structures', 'data', 'minecraft', 'structure'), path.join(OUT, 'data', 'structure'));

// ---------------------------------------------------------------------------------------------
// 8. Registry manifests
// ---------------------------------------------------------------------------------------------
writeJson(path.join(OUT, 'blocks.json'), { blocks: blocksOut, states: stateParts, parts });
writeJson(path.join(OUT, 'models.json'), { sprites: spriteNames, models });
writeJson(path.join(OUT, 'items.json'), { definitions: itemDefs, components: itemComponents });
writeJson(path.join(OUT, 'particles.json'), particleDefs);

const version = readJson(path.join(CACHE, 'textures', 'version.json'));
const gameVersion = readJson(path.join(CACHE, 'textures', 'game-version.json'));
writeJson(path.join(OUT, 'manifest.json'), {
  version: version.id, releaseTime: version.releaseTime, worldVersion: gameVersion.world_version,
  protocol: gameVersion.protocol_version, packFormat: gameVersion.pack_version,
  builtAt: new Date().toISOString(),
  counts: { blocks: blocksOut.length, states: stateCount, models: models.length, items: Object.keys(itemDefs).length, sprites: spriteNames.length },
});

for (const w of warnings) console.warn('[extract] warning: ' + w);
if (errors.length) {
  console.error(`[extract] FAILED with ${errors.length} error(s):`);
  for (const e of errors.slice(0, 200)) console.error('  - ' + e);
  process.exit(1);
}
log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
