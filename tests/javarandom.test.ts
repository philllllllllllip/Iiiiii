import { describe, it, expect } from 'vitest';
import { JavaRandom } from '../src/util/javarandom';

// Reference values from java.util.Random.
describe('JavaRandom', () => {
  it('matches Java for seed 42', () => {
    const r = new JavaRandom(42);
    expect([r.nextInt(), r.nextInt(), r.nextInt()]).toEqual([-1170105035, 234785527, -1360544799]);
  });
  it('nextInt(bound) matches', () => {
    const r = new JavaRandom(42);
    expect([r.nextInt(10), r.nextInt(10), r.nextInt(10), r.nextInt(16)]).toEqual([0, 3, 8, 0]);
  });
  it('nextLong / nextDouble match', () => {
    const r = new JavaRandom(0);
    expect(r.nextLong()).toBe(-4962768465676381896n);
    const d = new JavaRandom(0);
    expect(d.nextDouble()).toBe(0.730967787376657);
    expect(d.nextGaussian()).toBe(-1.2895731239084833);
    expect(d.nextFloat()).toBeCloseTo(0.550437, 6);
  });
  it('negative 64-bit seeds', () => {
    const r = new JavaRandom(-123456789012345n);
    expect(r.nextInt(7)).toBe(0);
    expect(r.nextInt(1 << 20)).toBe(23383);
    expect(r.nextLong()).toBe(-8148537296809300264n);
  });
});
