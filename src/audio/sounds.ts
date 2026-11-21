// SoundManager: sounds.json events -> weighted variants, Web Audio playback with per-category volume,
// vanilla pitch/volume per call and linear attenuation over the sound's range (attenuation distance 16).
import { GEN } from '../assets/bundle';

interface SoundDef { name: string; volume: number; pitch: number; weight: number; stream: boolean; type: 'file' | 'event'; attenuation_distance?: number }
interface EventDef { sounds: (string | Partial<SoundDef> & { name: string })[]; replace?: boolean; subtitle?: string }

/** SoundType per block family (SoundType.java constants as used by Blocks.java). */
const SOUND_TYPES: [RegExp, string][] = [
  [/_wool$|_carpet$/, 'wool'], [/glass|^ice$|packed_ice|blue_ice|^glowstone$|sea_lantern|beacon|conduit/, 'glass'],
  [/^(grass_block|podzol|mycelium|.*_leaves|short_grass|tall_grass|fern|large_fern|.*_sapling|sugar_cane|vine|lily_pad|dead_bush|bush|hay_block|kelp|kelp_plant|seagrass|tall_seagrass|sponge|wet_sponge|.*_tulip|poppy|dandelion|allium|azure_bluet|blue_orchid|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|sunflower|lilac|rose_bush|peony|tnt|melon|pumpkin|carved_pumpkin|.*_mushroom|moss_carpet|wheat|carrots|potatoes|beetroots)$/, 'grass'],
  [/^(dirt|coarse_dirt|gravel|clay|farmland|dirt_path|rooted_dirt|.*concrete_powder)$/, 'gravel'],
  [/^(sand|red_sand|suspicious_sand|soul_sand|cactus|snow|snow_block|powder_snow)$/, 'sand'],
  [/_planks$|_log$|_wood$|^stripped_|_fence$|_fence_gate$|_door$|_trapdoor$|_stairs$|_slab$|bookshelf|crafting_table|chest|barrel|jukebox|note_block|_sign$|ladder|composter|lectern|loom|cartography_table|fletching_table|smithing_table|beehive|campfire/, 'wood'],
  [/^(iron_block|gold_block|diamond_block|emerald_block|netherite_block|iron_bars|iron_door|iron_trapdoor|anvil|chipped_anvil|damaged_anvil|hopper|cauldron|.*_cauldron|bell|lantern|soul_lantern|chain|redstone_block|lapis_block|heavy_core)$/, 'metal'],
  [/copper/, 'copper'], [/deepslate/, 'deepslate'], [/tuff/, 'tuff'], [/calcite/, 'calcite'], [/amethyst/, 'amethyst_block'],
  [/netherrack/, 'netherrack'], [/nether_brick|red_nether/, 'nether_bricks'], [/basalt/, 'basalt'], [/^mud$/, 'mud'], [/mud_brick/, 'mud_bricks'],
  [/^moss_block$/, 'moss'], [/^honey_block$/, 'honey_block'], [/^slime_block$/, 'slime_block'], [/^bone_block$/, 'bone_block'],
  [/sculk/, 'sculk'], [/cherry/, 'cherry_wood'], [/bamboo/, 'bamboo_wood'], [/^(crimson|warped)_(planks|stem|hyphae|.*)$/, 'nether_wood'], [/^scaffolding$/, 'scaffolding'],
  [/sulfur/, 'stone'],
];
const typeCache = new Map<string, string>();
export function blockSoundType(name: string): string {
  let t = typeCache.get(name);
  if (!t) { t = SOUND_TYPES.find(([re]) => re.test(name))?.[1] ?? 'stone'; typeCache.set(name, t); }
  return t;
}
/** SoundType volume/pitch (most are 1/1; wool/grass etc. also 1/1; place/break at volume (v+1)/2, pitch p*0.8). */

export class SoundManager {
  readonly ctx: AudioContext;
  private events: Record<string, EventDef> = {};
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private gains = new Map<string, GainNode>();
  private master: GainNode;
  listener = { x: 0, y: 0, z: 0, yaw: 0 };
  volumes: Record<string, number> = {};
  private music: AudioBufferSourceNode | null = null;
  private musicDelay = 100;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination);
  }
  async load(): Promise<void> {
    const r = await fetch(GEN + 'sounds.json');
    if (!r.ok) throw new Error('sounds.json missing: run `npm run assets`');
    this.events = await r.json();
  }
  resume(): void { if (this.ctx.state !== 'running') this.ctx.resume(); }
  setVolumes(v: Record<string, number>): void {
    this.volumes = v;
    this.master.gain.value = v.master ?? 1;
    for (const [cat, g] of this.gains) g.gain.value = v[cat] ?? 1;
  }
  private gain(cat: string): GainNode {
    let g = this.gains.get(cat);
    if (!g) { g = this.ctx.createGain(); g.gain.value = this.volumes[cat] ?? 1; g.connect(this.master); this.gains.set(cat, g); }
    return g;
  }
  private pick(event: string): SoundDef | null {
    const e = this.events[event];
    if (!e) return null;
    const defs: SoundDef[] = e.sounds.map((s) => (typeof s === 'string' ? { name: s, volume: 1, pitch: 1, weight: 1, stream: false, type: 'file' } : { volume: 1, pitch: 1, weight: 1, stream: false, type: 'file', ...s } as SoundDef));
    let total = 0; for (const d of defs) total += d.weight;
    let r = Math.random() * total;
    for (const d of defs) { r -= d.weight; if (r < 0) return d.type === 'event' ? this.pick(d.name) : d; }
    return defs[0];
  }
  private buffer(name: string): Promise<AudioBuffer | null> {
    let b = this.buffers.get(name);
    if (!b) {
      b = fetch(GEN + 'sounds/' + name.replace('minecraft:', '') + '.ogg').then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('missing sound ' + name))))
        .then((ab) => this.ctx.decodeAudioData(ab)).catch((e) => { console.error(e); return null; });
      this.buffers.set(name, b);
    }
    return b;
  }
  /** Play an event. Position null = non-positional (UI). Category from SoundSource. */
  play(event: string, category: string, x: number | null, y: number, z: number, volume = 1, pitch = 1): void {
    const d = this.pick(event);
    if (!d) return;
    const vol = Math.min(1, volume * d.volume), p = pitch * d.pitch;
    let att = 1, pan = 0;
    if (x !== null) {
      const range = Math.max(volume, 1) * (d.attenuation_distance ?? 16);
      const dx = x - this.listener.x, dy = y - this.listener.y, dz = z - this.listener.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > range) return;
      att = 1 - dist / range;
      const yr = (this.listener.yaw * Math.PI) / 180;
      const rx = dx * Math.cos(yr) + dz * Math.sin(yr);
      pan = dist > 0.001 ? Math.max(-1, Math.min(1, -rx / Math.max(dist, 1))) : 0;
    }
    this.buffer(d.name).then((buf) => {
      if (!buf) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf; src.playbackRate.value = Math.max(0.5, Math.min(2, p));
      const g = this.ctx.createGain(); g.gain.value = vol * att;
      const pn = this.ctx.createStereoPanner(); pn.pan.value = pan;
      src.connect(g); g.connect(pn); pn.connect(this.gain(category));
      src.start();
    });
  }
  /** Block sound (SoundType): volume (v+1)/2 and pitch 0.8 for break/place, 0.25/0.5 for hit. */
  block(name: string, kind: string, x: number, y: number, z: number, vol: number, pitch: number): void {
    const t = blockSoundType(name);
    const evt = `block.${t}.${kind === 'hit' ? 'hit' : kind}`;
    const e = this.events[evt] ? evt : `block.stone.${kind}`;
    const v = kind === 'hit' ? 0.25 : (1 + 1) / 2;
    const p = kind === 'hit' ? 0.5 : 0.8;
    this.play(e, 'block', x, y, z, kind === 'hit' ? v : v * vol, kind === 'hit' ? p : p * (pitch / 0.8));
  }
  /** MusicManager: menu music on the title screen, game music in world, random delays. */
  tickMusic(kind: 'menu' | 'game' | 'creative'): void {
    if (this.music || this.ctx.state !== 'running') return;
    if (--this.musicDelay > 0) return;
    const evt = kind === 'menu' ? 'music.menu' : kind === 'creative' ? 'music.creative' : 'music.game';
    const d = this.pick(evt);
    if (!d) return;
    this.musicDelay = 12000 + Math.floor(Math.random() * 12000);
    this.buffer(d.name).then((buf) => {
      if (!buf || this.music) return;
      const src = this.ctx.createBufferSource(); src.buffer = buf;
      const g = this.ctx.createGain(); g.gain.value = d.volume;
      src.connect(g); g.connect(this.gain('music'));
      src.onended = () => { this.music = null; };
      this.music = src; src.start();
    });
  }
  stopMusic(): void { if (this.music) { this.music.onended = null; this.music.stop(); this.music = null; this.musicDelay = 100; } }
}
