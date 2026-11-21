import { describe, it, expect } from 'vitest';
import { Xoroshiro } from '../src/worldgen/random';
import { md5 } from '../src/worldgen/md5';

describe('Xoroshiro128++ (values from Java)', () => {
  it('seeded stream matches', () => {
    const r = Xoroshiro.fromSeed(12345n);
    expect(r.nextLong()).toBe(-8118485274630516485n);
    expect(r.nextLong()).toBe(8241557746459281790n);
    expect(r.nextInt(100)).toBe(87);
    expect(r.nextDouble()).toBe(0.06648869277406588);
  });
  it('md5 matches', () => {
    expect(Array.from(md5('minecraft:terrain')).map((b) => b.toString(16).padStart(2, '0')).join('')).toBe('1ee555222ef96f14e2bedfdbebe43d33');
  });
});
