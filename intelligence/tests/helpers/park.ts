import { harborLightsFixturePark, parkArtifact } from '../../src/fixtures/harbor-lights.ts';
import { parkContext } from '../../src/population/park.ts';

export function fixturePark() {
  const bundle = harborLightsFixturePark();
  const art = parkArtifact(bundle);
  return { bundle, art, ctx: parkContext(bundle, art.ref.sha256) };
}
