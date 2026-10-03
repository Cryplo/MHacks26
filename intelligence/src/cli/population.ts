/**
 * Generates and validates a population manifest offline.
 *   npm run population:fixture -- [--guests 300] [--seed seed-001] [--out fixtures/population-300.fixture.json]
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_CROWD_300 } from '../fixtures/crowds.ts';
import { harborLightsFixturePark, parkArtifact } from '../fixtures/harbor-lights.ts';
import { generatePopulation, parkContext } from '../population/index.ts';

const { values } = parseArgs({
  options: {
    guests: { type: 'string', default: String(DEFAULT_CROWD_300.guestCount) },
    seed: { type: 'string', default: DEFAULT_CROWD_300.seed },
    out: { type: 'string' },
    summary: { type: 'string' },
  },
});

const bundle = harborLightsFixturePark();
const park = parkContext(bundle, parkArtifact(bundle).ref.sha256);
const crowd = { ...DEFAULT_CROWD_300, guestCount: Number(values.guests), seed: values.seed! };
const r = await generatePopulation({ crowd, park, closeAfterMs: bundle.closeAfterMs });
if (!r.ok) {
  console.error(JSON.stringify({ ok: false, errors: r.errors }, null, 2));
  process.exit(1);
}
if (values.out) writeFileSync(values.out, `${JSON.stringify(r.manifest, null, 2)}\n`);
if (values.summary) writeFileSync(values.summary, `${JSON.stringify(r.summary, null, 2)}\n`);
console.log(JSON.stringify({
  ok: true, populationId: r.manifest.populationId, sha256: r.sha256, guests: r.manifest.personas.length,
  groups: r.manifest.groups.length, warnings: r.summary.warnings, disclaimer: r.summary.disclaimer,
}, null, 2));
