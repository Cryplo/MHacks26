import type { Id, Vec2 } from '../../contract/behavior-v1';

/**
 * Picks the agent whose DISPLAYED position (what the user sees) is nearest to the world
 * point, within radiusM. Ties break by agent ID so the result is deterministic.
 */
export function pickAgent(display: ReadonlyMap<Id, Vec2>, world: Vec2, radiusM: number): Id | null {
  let best: Id | null = null;
  let bestD = radiusM * radiusM;
  for (const [id, p] of display) {
    const dx = p.xM - world.xM;
    const dy = p.yM - world.yM;
    const d = dx * dx + dy * dy;
    if (d < bestD || (d === bestD && best !== null && id < best)) {
      bestD = d;
      best = id;
    }
  }
  return best;
}
