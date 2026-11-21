// Fetches vanilla Minecraft Java Edition 26.3 assets and data into .cache/vanilla.
// Sources are pinned to exact commits so the build is reproducible.
// Mojang's own CDN (piston-meta / resources.download.minecraft.net) is not used:
// the two GitHub mirrors below carry the same files extracted from the 26.3 client jar
// and asset index. See DEVIATIONS.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, '.cache', 'vanilla');

export const SOURCES = [
  {
    name: 'textures',
    url: 'https://github.com/InventivetalentDev/minecraft-assets.git',
    ref: '26.3',
    commit: 'fac4eb20fa2ef7ded38943e87cd219c8c9b4ef31',
    sparse: [
      '/assets/minecraft/textures/', '/assets/minecraft/lang/en_us.json', '/assets/minecraft/font/',
      '/assets/minecraft/models/', '/assets/minecraft/blockstates/', '/assets/minecraft/texts/',
      '/assets/minecraft/items/', '/version.json', '/game-version.json',
    ],
  },
  {
    name: 'assets',
    url: 'https://github.com/misode/mcmeta.git',
    ref: '26.3-assets',
    commit: '79962f2b091fb6213b425b277a8725d737f3def8',
    sparse: [
      '/assets/minecraft/sounds/', '/assets/minecraft/sounds.json', '/assets/minecraft/shaders/',
      '/assets/minecraft/particles/', '/assets/minecraft/atlases/', '/assets/minecraft/equipment/',
      '/assets/minecraft/post_effect/', '/version.json',
    ],
  },
  {
    name: 'data',
    url: 'https://github.com/misode/mcmeta.git',
    ref: '26.3-data-json',
    commit: '5f312935898c8f75f64d185b9874b129d0c67287',
    sparse: ['/data/minecraft/', '/version.json'],
  },
  {
    name: 'structures',
    url: 'https://github.com/misode/mcmeta.git',
    ref: '26.3-data',
    commit: '538b2b167248c648b2198f2c0d56eced10dfc0cf',
    sparse: ['/data/minecraft/structure/', '/version.json'],
  },
  {
    name: 'summary',
    url: 'https://github.com/misode/mcmeta.git',
    ref: '26.3-summary',
    commit: 'd96c75fec200c4580dd75e033a76341521165461',
    sparse: ['/blocks/data.min.json', '/registries/data.min.json', '/item_components/data.min.json', '/sounds/data.min.json', '/version.json'],
  },
];

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 28 }).toString().trim();
}

function fetchSource(src) {
  const dir = path.join(CACHE, src.name);
  if (fs.existsSync(path.join(dir, '.git'))) {
    const head = git(['rev-parse', 'HEAD'], dir);
    if (head === src.commit) { console.log(`[assets] ${src.name}: up to date (${head.slice(0, 10)})`); return dir; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  console.log(`[assets] ${src.name}: cloning ${src.url} @ ${src.ref}`);
  git(['init', '-q'], dir);
  git(['remote', 'add', 'origin', src.url], dir);
  git(['config', 'core.sparseCheckout', 'true'], dir);
  git(['sparse-checkout', 'set', '--no-cone', ...src.sparse], dir);
  const refspec = src.ref.match(/^\d/) && src.name !== 'textures' ? `refs/tags/${src.ref}` : `refs/heads/${src.ref}`;
  git(['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', refspec], dir);
  git(['checkout', '-q', 'FETCH_HEAD'], dir);
  const head = git(['rev-parse', 'HEAD'], dir);
  if (head !== src.commit) {
    throw new Error(`[assets] ${src.name}: expected commit ${src.commit} but ${src.ref} resolved to ${head}. Refusing to build from an unverified source.`);
  }
  return dir;
}

export function fetchAll() {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const s of SOURCES) fetchSource(s);
  const v = JSON.parse(fs.readFileSync(path.join(CACHE, 'textures', 'version.json'), 'utf8'));
  if (v.id !== '26.3') throw new Error(`[assets] textures source is version ${v.id}, expected 26.3`);
  return CACHE;
}

if (import.meta.url === `file://${process.argv[1]}`) fetchAll();
