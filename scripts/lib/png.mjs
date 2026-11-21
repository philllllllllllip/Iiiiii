// PNG helpers: decode/encode with pngjs, exact pixel copies, shelf packing.
import fs from 'node:fs';
import { PNG } from 'pngjs';

export function readPng(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: png.data };
}

export function writePng(file, img) {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy ? img.data.copy(png.data) : png.data.set(img.data);
  fs.writeFileSync(file, PNG.sync.write(png, { colorType: 6 }));
}

export function createImage(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

/** Copy a w*h rect from src(sx,sy) to dst(dx,dy). Byte exact. */
export function blit(src, sx, sy, w, h, dst, dx, dy) {
  for (let y = 0; y < h; y++) {
    const s = ((sy + y) * src.width + sx) * 4;
    const d = ((dy + y) * dst.width + dx) * 4;
    src.data.copy(dst.data, d, s, s + w * 4);
  }
}

/** Blit with a 1px border extruded from the rect's own edge pixels (anti-bleed padding). */
export function blitPadded(src, sx, sy, w, h, dst, dx, dy) {
  blit(src, sx, sy, w, h, dst, dx + 1, dy + 1);
  const px = (x, y) => ((y * dst.width + x) * 4);
  for (let x = 0; x < w; x++) {
    dst.data.copy(dst.data, px(dx + 1 + x, dy), px(dx + 1 + x, dy + 1), px(dx + 1 + x, dy + 1) + 4);
    dst.data.copy(dst.data, px(dx + 1 + x, dy + h + 1), px(dx + 1 + x, dy + h), px(dx + 1 + x, dy + h) + 4);
  }
  for (let y = 0; y < h + 2; y++) {
    dst.data.copy(dst.data, px(dx, dy + y), px(dx + 1, dy + y), px(dx + 1, dy + y) + 4);
    dst.data.copy(dst.data, px(dx + w + 1, dy + y), px(dx + w, dy + y), px(dx + w, dy + y) + 4);
  }
}

/** Classify alpha: 'solid' (all 255), 'cutout' (only 0/255), 'translucent' (any partial). */
export function alphaClass(img, x, y, w, h) {
  let hasZero = false, hasPartial = false;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const a = img.data[((y + j) * img.width + x + i) * 4 + 3];
    if (a === 0) hasZero = true; else if (a !== 255) hasPartial = true;
  }
  return hasPartial ? 'translucent' : hasZero ? 'cutout' : 'solid';
}

/**
 * Shelf packer. Items: {w,h,key}. Returns {width,height,rects: Map key->{x,y}} where (x,y) is the
 * top-left of the padded cell; content starts at +pad.
 */
export function shelfPack(items, maxWidth, pad) {
  const sorted = [...items].sort((a, b) => (b.h - a.h) || (b.w - a.w) || (a.key < b.key ? -1 : 1));
  const rects = new Map();
  let x = 0, y = 0, shelfH = 0, width = 0;
  for (const it of sorted) {
    const cw = it.w + pad * 2, ch = it.h + pad * 2;
    if (cw > maxWidth) throw new Error(`sprite ${it.key} (${it.w}) wider than atlas ${maxWidth}`);
    if (x + cw > maxWidth) { y += shelfH; x = 0; shelfH = 0; }
    rects.set(it.key, { x, y });
    x += cw; shelfH = Math.max(shelfH, ch); width = Math.max(width, x);
  }
  const height = y + shelfH;
  const pow2 = (v) => { let p = 1; while (p < v) p <<= 1; return p; };
  return { width: pow2(width), height: pow2(height), rects };
}
