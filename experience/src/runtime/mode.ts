/**
 * The labels an operator sees for where data comes from. Always shown prominently and in
 * exports. Mock is never presented as a real-Jev comparison; fixture is never "live".
 */
import type { Quality, RunView } from '../../contract/behavior-v1';
import type { Profile } from './config';

export type DisplayMode = 'Fixture' | 'Mock' | 'Live Jev' | 'Degraded' | 'Recorded';

export function displayModes(input: { profile: Profile; run?: Pick<RunView, 'mode'> | null; quality?: Quality | null; recorded?: boolean }): DisplayMode[] {
  const out: DisplayMode[] = [];
  if (input.profile === 'fixture') out.push('Fixture');
  if (input.recorded || input.run?.mode === 'replay') out.push('Recorded');
  if (input.profile === 'live' && input.run && input.run.mode !== 'replay') {
    const counts = input.quality?.behaviorCounts;
    const jev = (counts?.jev ?? 0) + (counts?.cache ?? 0);
    if (input.run.mode === 'live' || (input.run.mode === 'experiment' && jev > 0)) out.push('Live Jev');
    else out.push('Mock');
    if ((counts?.fallback ?? 0) > 0) out.push('Degraded');
  }
  return out;
}

export const MODE_EXPLANATION: Record<DisplayMode, string> = {
  Fixture: 'Scripted fixture data for UI development. No Engine simulation, no Jev, guests do not react to interventions.',
  Mock: 'Engine simulation with a deterministic mock probability provider. Not a real-Jev comparison.',
  'Live Jev': 'Engine simulation with decision distributions from Jev.',
  Degraded: 'Some decisions used the declared live-timeout fallback. Those are not evidence of Jev behavior.',
  Recorded: 'Playback of saved frames. No new inference or simulation happens during replay.',
};

export const modeClass = (m: DisplayMode) =>
  m === 'Fixture' ? 'mode-fixture' : m === 'Mock' ? 'mode-mock' : m === 'Live Jev' ? 'mode-live' : m === 'Degraded' ? 'mode-degraded' : 'mode-recorded';
