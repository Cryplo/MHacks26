/** C-05: authored Harbor Lights content checks (palette, zones, IDs, services, presets). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent, contentRoot } from '../../content/harbor-lights/tools/load';
import { validateContent } from '../../content/harbor-lights/tools/validate-lib';
import { CELL, paintStage, serpentine } from '../../content/harbor-lights/tools/layout-lib';
import { assembleBundle } from '../../content/harbor-lights/tools/assemble';
import { sha256Hex } from '../../src/domain/canonical';
import { parkBundleSchema, validate } from '../../src/domain/schemas';

const content = loadContent();

describe('Harbor Lights content', () => {
  it('passes all standalone validation rules', () => {
    expect(validateContent(content)).toEqual([]);
  });
  it('is ~200x150 one-metre cells', () => {
    expect([content.layout.width, content.layout.height, content.layout.cellM]).toEqual([200, 150, 1]);
  });
  it('detects palette violations and drift (antialiased pixel)', () => {
    const png = content.pngs[1]!;
    const rgba = new Uint8Array(png.rgba);
    rgba[4 * 5000] = 200; // blend a pixel
    const errors = validateContent({ ...content, pngs: { ...content.pngs, 1: { ...png, rgba } } });
    expect(errors.some((e) => e.includes('categorical palette'))).toBe(true);
  });
  it('detects an unowned queue cell and a broken reference', () => {
    const layout = structuredClone(content.layout);
    layout.places = layout.places.filter((p) => p.id !== 'churro_cart');
    const errors = validateContent({ ...content, layout });
    expect(errors.some((e) => e.includes('churro_cart'))).toBe(true);
  });
  it('detects a dishonest primary A/B that changes more than the pass price', () => {
    const presets = structuredClone(content.presets);
    const b = presets.find((p) => p.meta.primaryAB === 'B')!;
    b.scenario.events.push({ id: 'extra', atMs: 0, order: 1, change: { kind: 'closure', placeId: 'coaster_tempest', closed: true } });
    expect(validateContent({ ...content, presets }).some((e) => e.includes('ONLY the pass price'))).toBe(true);
  });
  it('queue masks are serpentine, head-first, and every queue cell is owned once', () => {
    const p = paintStage(content.layout, 2);
    const owned = new Set(p.queueZones.flatMap((z) => z.cellIndices));
    const queueCells = [...p.codes].map((c, i) => (c === CELL.queue ? i : -1)).filter((i) => i >= 0);
    expect(queueCells.every((i) => owned.has(i))).toBe(true);
    for (const z of p.queueZones) {
      for (let i = 1; i < z.cellIndices.length; i++) {
        const a = z.cellIndices[i - 1]!; const b = z.cellIndices[i]!;
        expect(Math.abs((a % 200) - (b % 200)) + Math.abs(Math.floor(a / 200) - Math.floor(b / 200))).toBe(1);
      }
    }
    expect(serpentine({ id: 'q', x: 0, y: 0, w: 3, h: 2, entryCorner: 'nw', laneAxis: 'x' })).toEqual([
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 1 },
    ]);
  });
  it('generated queue-zones.json matches a fresh paint (no drift)', () => {
    for (const stage of [1, 2] as const) {
      const file = JSON.parse(readFileSync(join(contentRoot, 'generated', `stage${stage}`, 'queue-zones.json'), 'utf8'));
      expect(file.queueZones).toEqual(paintStage(content.layout, stage).queueZones);
    }
  });
  it('stage 1 keeps stable place IDs in stage 2 and has 4-6 attractions; stage 2 has >= 15', () => {
    const s1 = content.places.filter((p) => p.stage === 1).map((p) => p.id);
    const s2 = paintStage(content.layout, 2);
    for (const id of s1) expect(s2.entrances[id]).toBeDefined();
    const count = (stage: number) => content.places.filter((p) => p.stage <= stage && (p.kind === 'ride' || p.kind === 'show')).length;
    expect(count(1)).toBeGreaterThanOrEqual(4);
    expect(count(1)).toBeLessThanOrEqual(6);
    expect(count(2)).toBeGreaterThanOrEqual(15);
  });
  it('fixture bundles equal a fresh assembly and validate as ParkBundle', async () => {
    for (const stage of [1, 2] as const) {
      const committed = JSON.parse(readFileSync(join(contentRoot, '..', '..', 'fixtures', 'parks', `harbor-lights-stage${stage}.bundle.json`), 'utf8'));
      const { bundle, errors } = await assembleBundle(content.layout, content.places, content.park, stage, sha256Hex);
      expect(errors).toEqual([]);
      expect(committed).toEqual(bundle);
      expect(validate(parkBundleSchema, bundle).ok).toBe(true);
      const bytes = Uint8Array.from(atob(bundle.grid.cellsBase64), (c) => c.charCodeAt(0));
      expect(await sha256Hex(bytes)).toBe(bundle.grid.cellsSha256);
      expect(bytes.length).toBe(bundle.grid.width * bundle.grid.height);
    }
  });
});
