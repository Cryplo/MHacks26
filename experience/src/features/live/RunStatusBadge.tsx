import type { RunStatus } from '../../../contract/behavior-v1';

const MAP: Record<RunStatus, { tone: string; label: string; title: string }> = {
  preparing: { tone: 'info', label: 'Preparing', title: 'Engine is preparing navigation and state for this run.' },
  ready: { tone: 'info', label: 'Ready', title: 'Prepared and ready to start.' },
  running: { tone: 'ok', label: 'Running', title: 'Simulation clock is advancing.' },
  paused: { tone: 'neutral', label: 'Paused', title: 'Paused by an operator.' },
  blocked: { tone: 'warn', label: 'Blocked', title: 'Waiting for required decision distributions (inference delay, not guest time).' },
  draining: { tone: 'info', label: 'Draining', title: 'Finishing in-flight work.' },
  completed: { tone: 'ok', label: 'Completed', title: 'Reached the horizon.' },
  failed: { tone: 'bad', label: 'Failed', title: 'The run failed.' },
  cancelled: { tone: 'neutral', label: 'Cancelled', title: 'Cancelled by an operator.' },
};
export function RunStatusBadge(props: { status: RunStatus }) {
  const m = MAP[props.status];
  return <span className={`badge ${m.tone}`} data-testid="run-status" title={m.title}>{m.label}</span>;
}
