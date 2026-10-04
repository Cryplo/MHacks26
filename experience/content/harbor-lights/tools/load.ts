/** Node-side loader for content files (CLI tools and Vitest). */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import type { Layout } from './layout-lib';
import type { ParkContent, PlaceContent } from './assemble';
import type { ContentInput, ScenarioPreset } from './validate-lib';

export const contentRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = <T>(p: string) => JSON.parse(readFileSync(join(contentRoot, p), 'utf8')) as T;

export function loadContent(): ContentInput {
  const presets = readdirSync(join(contentRoot, 'scenarios')).filter((f) => f.endsWith('.json')).sort()
    .map((f) => json<ScenarioPreset>(join('scenarios', f)));
  const pngs: ContentInput['pngs'] = {};
  for (const stage of [1, 2] as const) {
    const png = PNG.sync.read(readFileSync(join(contentRoot, 'generated', `stage${stage}`, 'grid.png')));
    pngs[stage] = { width: png.width, height: png.height, rgba: new Uint8Array(png.data) };
  }
  return {
    layout: json<Layout>('layout.json'),
    places: json<{ places: PlaceContent[] }>('places.json').places,
    park: json<ParkContent>('park.json'),
    presets,
    pngs,
  };
}
