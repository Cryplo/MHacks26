/** Day/night lighting curve: continuous, bright at midday, lit at night. */
import { describe, expect, it } from 'vitest';
import { lightingAt, parseOpenLocal } from '../../src/renderer/lighting';

describe('day/night lighting', () => {
  it('is bright with lights off at midday and dark with lights on at night', () => {
    const noon = lightingAt(12.5); const night = lightingAt(22);
    expect(noon.lights).toBe(0); expect(night.lights).toBe(1);
    expect(Math.min(...noon.world)).toBeGreaterThan(0.95);
    expect(Math.max(...night.world)).toBeLessThan(0.65);
    expect(noon.phase).toBe('day'); expect(lightingAt(17).phase).toBe('golden hour'); expect(night.phase).toBe('night');
  });
  it('changes continuously (no hard switches) across the whole day', () => {
    let prev = lightingAt(0);
    for (let h = 0.05; h <= 24; h += 0.05) {
      const cur = lightingAt(h);
      for (let c = 0; c < 3; c++) expect(Math.abs(cur.world[c]! - prev.world[c]!)).toBeLessThan(0.05);
      expect(Math.abs(cur.lights - prev.lights)).toBeLessThan(0.06);
      prev = cur;
    }
  });
  it('keeps guests brighter than the world at night', () => {
    const n = lightingAt(23);
    for (let c = 0; c < 3; c++) expect(n.guest[c]!).toBeGreaterThan(n.world[c]! + 0.2);
  });
  it('parses park opening time', () => {
    expect(parseOpenLocal('09:00')).toBe(9); expect(parseOpenLocal('17:30')).toBe(17.5); expect(parseOpenLocal('bad')).toBe(9);
  });
});
