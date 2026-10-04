import type { RunStatus } from '../../../contract/behavior-v1';

const MAP: Record<RunStatus, { tone: string; icon: string; label: string }> = {
  preparing: { tone: 'info', icon: '…', label: 'Preparing' },
  ready: { tone: 'info', icon: '○', label: 'Ready' },
  running: { tone: 'ok', icon: '▶', label: 'Running' },
  paused: { tone: 'neutral', icon: '‖', label: 'Paused' },
  blocked: { tone: 'warn', icon: '⧗', label: 'Blocked (waiting for inference)' },
  draining: { tone: 'info', icon: '⇥', label: 'Draining' },
  completed: { tone: 'ok', icon: '✓', label: 'Completed' },
  failed: { tone: 'bad', icon: '✕', label: 'Failed' },
  cancelled: { tone: 'neutral', icon: '⊘', label: 'Cancelled' },
};
export function RunStatusBadge(props: { status: RunStatus }) {
  const m = MAP[props.status];
  return <span className={`badge ${m.tone}`} data-testid="run-status"><span aria-hidden="true">{m.icon}</span>{m.label}</span>;
}
