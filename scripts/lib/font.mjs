// Builds glyph metrics from vanilla font providers (BitmapProvider / SpaceProvider / UnihexProvider).
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { readPng, createImage, writePng } from './png.mjs';
import { stripNs } from './models.mjs';

function* codepoints(s) { for (const ch of s) yield ch.codePointAt(0); }

/** Expand a font definition into an ordered flat list of concrete providers. */
function expandProviders(fontDir, id, out = []) {
  const j = JSON.parse(fs.readFileSync(path.join(fontDir, stripNs(id) + '.json'), 'utf8'));
  for (const p of j.providers) {
    if (p.type === 'reference') expandProviders(fontDir, p.id, out);
    else out.push(p);
  }
  return out;
}

/**
 * @param texDir textures root, fontDir font json root, outDir output, neededText string of all text to cover with unifont
 */
export function buildFont({ texDir, fontDir, outDir, neededText }) {
  const providers = expandProviders(fontDir, 'default');
  const glyphs = {}; // cp -> glyph
  const sheets = [];
  const unihex = [];
  for (const p of providers) {
    if (p.type === 'space') {
      for (const [ch, adv] of Object.entries(p.advances)) {
        const cp = ch.codePointAt(0);
        if (!(cp in glyphs)) glyphs[cp] = { space: true, advance: adv };
      }
    } else if (p.type === 'bitmap') {
      const file = stripNs(p.file);
      const img = readPng(path.join(texDir, file));
      const rows = p.chars.length;
      const cols = [...p.chars[0]].length;
      const cellW = img.width / cols, cellH = img.height / rows;
      if (!Number.isInteger(cellW) || !Number.isInteger(cellH)) throw new Error(`font sheet ${file} not divisible into ${cols}x${rows}`);
      const height = p.height ?? 8;
      const scale = height / cellH;
      const sheetIdx = sheets.length;
      sheets.push({ file: 'textures/' + file, width: img.width, height: img.height });
      p.chars.forEach((row, ry) => {
        [...row].forEach((ch, rx) => {
          const cp = ch.codePointAt(0);
          if (cp === 0 || cp in glyphs) return;
          // vanilla getActualGlyphWidth: rightmost column containing a non-transparent pixel
          let w = 0;
          for (let x = cellW - 1; x >= 0 && w === 0; x--) {
            for (let y = 0; y < cellH; y++) {
              if (img.data[((ry * cellH + y) * img.width + rx * cellW + x) * 4 + 3] !== 0) { w = x + 1; break; }
            }
          }
          glyphs[cp] = {
            sheet: sheetIdx, x: rx * cellW, y: ry * cellH, w: cellW, h: cellH, scale,
            advance: Math.floor(0.5 + w * scale) + 1, ascent: p.ascent,
          };
        });
      });
    } else if (p.type === 'unihex') {
      if (p.filter && p.filter.jp) continue; // jp variant only when "Japanese glyph variants" is enabled
      unihex.push(p);
    } else {
      throw new Error(`unsupported font provider ${p.type}`);
    }
  }
  // Unifont fallback for every codepoint present in shipped text that the bitmap providers lack.
  const need = new Set();
  for (const cp of codepoints(neededText)) if (!(cp in glyphs) && cp >= 32) need.add(cp);
  const hexGlyphs = new Map();
  for (const p of unihex) {
    const zip = unzipSync(fs.readFileSync(path.join(fontDir, stripNs(p.hex_file).replace(/^font\//, ''))));
    for (const [name, data] of Object.entries(zip)) {
      if (!name.endsWith('.hex')) continue;
      for (const line of strFromU8(data).split('\n')) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const cp = parseInt(line.slice(0, i), 16);
        if (need.has(cp) && !hexGlyphs.has(cp)) hexGlyphs.set(cp, { bits: line.slice(i + 1).trim(), p });
      }
    }
  }
  const missing = [...need].filter((cp) => !hexGlyphs.has(cp));
  const uniCount = hexGlyphs.size;
  const perRow = 64;
  const uni = createImage(perRow * 16, Math.max(16, Math.ceil(uniCount / perRow) * 16));
  let n = 0;
  const uniSheet = sheets.length;
  for (const [cp, { bits, p }] of [...hexGlyphs].sort((a, b) => a[0] - b[0])) {
    const wpx = bits.length / 4; // 32 hex digits -> 8 wide, 64 -> 16 wide
    const ox = (n % perRow) * 16, oy = Math.floor(n / perRow) * 16;
    let left = wpx, right = -1;
    for (let y = 0; y < 16; y++) {
      const rowHex = bits.slice(y * (wpx / 4), (y + 1) * (wpx / 4));
      const v = BigInt('0x' + rowHex);
      for (let x = 0; x < wpx; x++) {
        if ((v >> BigInt(wpx - 1 - x)) & 1n) {
          const o = ((oy + y) * uni.width + ox + x) * 4;
          uni.data[o] = uni.data[o + 1] = uni.data[o + 2] = uni.data[o + 3] = 255;
          left = Math.min(left, x); right = Math.max(right, x);
        }
      }
    }
    for (const ov of p.size_overrides || []) {
      if (cp >= ov.from.codePointAt(0) && cp <= ov.to.codePointAt(0)) { left = ov.left; right = ov.right; }
    }
    if (right < 0) { glyphs[cp] = { space: true, advance: 4 }; n++; continue; }
    // UnihexProvider: glyph rendered at half scale (16px source -> 8 units), advance = width/2 + 1
    const width = right - left + 1;
    glyphs[cp] = { sheet: uniSheet, x: ox + left, y: oy, w: width, h: 16, scale: 0.5, advance: Math.floor(width / 2) + 1, ascent: 7, unihex: true };
    n++;
  }
  sheets.push({ file: 'font/unifont.png', width: uni.width, height: uni.height });
  fs.mkdirSync(path.join(outDir, 'font'), { recursive: true });
  writePng(path.join(outDir, 'font', 'unifont.png'), uni);
  return { sheets, glyphs, missingCount: missing.length, missing: missing.slice(0, 50) };
}
