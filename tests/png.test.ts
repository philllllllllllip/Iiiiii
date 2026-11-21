import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { decodePng } from '../src/assets/png';

const TEX = path.resolve(__dirname, '..', 'public', 'gen', 'textures');
function* walk(d: string): Generator<string> { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else if (p.endsWith('.png')) yield p; } }

it('decodePng matches pngjs on every vanilla texture', () => {
  let n = 0; const bad: string[] = [];
  for (const f of walk(TEX)) {
    const buf = fs.readFileSync(f);
    const ref = PNG.sync.read(buf);
    const mine = decodePng(new Uint8Array(buf));
    // Fully transparent texels: compare alpha only. pngjs zeroes their colour; we keep the stored colour
    // as stb_image (vanilla's NativeImage loader) does for tRNS images.
    let same = mine.width === ref.width && mine.height === ref.height;
    for (let i = 0; same && i < ref.data.length; i += 4) {
      if (ref.data[i + 3] !== mine.data[i + 3]) same = false;
      else if (ref.data[i + 3] !== 0 && (ref.data[i] !== mine.data[i] || ref.data[i + 1] !== mine.data[i + 1] || ref.data[i + 2] !== mine.data[i + 2])) same = false;
    }
    if (!same) bad.push(path.relative(TEX, f));
    n++;
  }
  console.log(`checked ${n} textures, mismatches: ${bad.length}`, bad.slice(0, 10));
  expect(bad).toEqual([]);
}, 300000);
