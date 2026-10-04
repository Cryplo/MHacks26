import { expect, it } from 'vitest';
import { displayModes, MODE_EXPLANATION } from '../../src/runtime/mode';
import { sourceLabel } from '../../src/features/inspector/evidence';
import { defaultRunConfig } from '../../src/features/setup/plan';
it('labels local runs and cached local evidence without claiming Jev', () => {
  expect(displayModes({profile: 'live', run: {mode: 'local'}})).toEqual(['Local Laya']);
  expect(sourceLabel('laya', 'laya', 'laya-model').text).toContain('Local Laya');
  expect(sourceLabel('cache', 'laya', 'laya-model').text).toContain('Local Laya');
  expect(MODE_EXPLANATION['Local Laya']).toContain('local');
  const config = defaultRunConfig('local');
  expect(config.versions.requestedModel).toBe('laya-multilingual-mlx-f2b4faf5');
  expect(config.versions.prompt).toBe('laya-compact-v1');
});
