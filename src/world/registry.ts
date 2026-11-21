// Block registry built from blocks.json. Global state ids are dense: block.first + local index, where the
// local index enumerates properties sorted by name with the last property varying fastest.
import type { BlocksJson, BlockJson } from '../assets/types';

export class BlockRegistry {
  readonly blocks: BlockJson[];
  readonly byName = new Map<string, number>();
  /** state id -> block index */
  readonly stateBlock: Uint16Array;
  readonly stateCount: number;
  private strides: number[][] = [];

  constructor(readonly json: BlocksJson) {
    this.blocks = json.blocks;
    this.stateCount = json.states.length;
    this.stateBlock = new Uint16Array(this.stateCount);
    json.blocks.forEach((b, i) => {
      this.byName.set(b.name, i);
      this.stateBlock.fill(i, b.first, b.first + b.count);
      const strides: number[] = new Array(b.props.length);
      let s = 1;
      for (let p = b.props.length - 1; p >= 0; p--) { strides[p] = s; s *= b.props[p][1].length; }
      this.strides.push(strides);
    });
  }

  block(state: number): BlockJson { return this.blocks[this.stateBlock[state]]; }
  name(state: number): string { return this.blocks[this.stateBlock[state]].name; }

  /** Default state of a block by name ("stone" or "minecraft:stone"). */
  defaultState(name: string): number {
    const i = this.byName.get(name.replace(/^minecraft:/, ''));
    if (i === undefined) throw new Error(`unknown block ${name}`);
    return this.blocks[i].def;
  }

  /** State with the given property values (others from the default state). */
  state(name: string, props: Record<string, string | number | boolean> = {}): number {
    let s = this.defaultState(name);
    for (const [k, v] of Object.entries(props)) s = this.withProp(s, k, String(v));
    return s;
  }

  props(state: number): Record<string, string> {
    const bi = this.stateBlock[state]; const b = this.blocks[bi];
    const local = state - b.first; const out: Record<string, string> = {};
    b.props.forEach(([n, vals], p) => { out[n] = vals[Math.floor(local / this.strides[bi][p]) % vals.length]; });
    return out;
  }

  prop(state: number, name: string): string | undefined {
    const bi = this.stateBlock[state]; const b = this.blocks[bi];
    const p = b.props.findIndex((x) => x[0] === name);
    if (p < 0) return undefined;
    const vals = b.props[p][1];
    return vals[Math.floor((state - b.first) / this.strides[bi][p]) % vals.length];
  }

  hasProp(state: number, name: string): boolean { return this.block(state).props.some((x) => x[0] === name); }

  withProp(state: number, name: string, value: string): number {
    const bi = this.stateBlock[state]; const b = this.blocks[bi];
    const p = b.props.findIndex((x) => x[0] === name);
    if (p < 0) throw new Error(`${b.name} has no property ${name}`);
    const vals = b.props[p][1];
    const ni = vals.indexOf(value);
    if (ni < 0) throw new Error(`${b.name}.${name} has no value ${value}`);
    const local = state - b.first;
    const cur = Math.floor(local / this.strides[bi][p]) % vals.length;
    return state + (ni - cur) * this.strides[bi][p];
  }
}
