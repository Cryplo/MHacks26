import { useId, useState, type ReactNode } from 'react';
import type { DomainError } from '../../contract/behavior-v1';
import { MODE_EXPLANATION, modeClass, type DisplayMode } from '../runtime/mode';

export function Panel(props: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; labelledBy?: string; as?: 'section' | 'div' | 'aside' }) {
  const id = useId();
  const Tag = props.as ?? 'section';
  return (
    <Tag className={`panel ${props.className ?? ''}`} aria-labelledby={props.title ? id : props.labelledBy}>
      {(props.title || props.actions) && (
        <header>
          {props.title && <h2 id={id} style={{ fontSize: 16, margin: 0 }}>{props.title}</h2>}
          {props.actions && <div className="row">{props.actions}</div>}
        </header>
      )}
      {props.children}
    </Tag>
  );
}

export function Alert(props: { tone: 'info' | 'ok' | 'warn' | 'bad'; title?: ReactNode; children?: ReactNode; role?: 'alert' | 'status' }) {
  const icon = { info: 'i', ok: '✓', warn: '!', bad: '✕' }[props.tone];
  return (
    <div className={`alert ${props.tone}`} role={props.role ?? (props.tone === 'bad' ? 'alert' : 'status')}>
      <span className="icon" aria-hidden="true">{icon}</span>
      <div className="grow">
        {props.title && <p><strong>{props.title}</strong></p>}
        {props.children}
      </div>
    </div>
  );
}

export function Spinner(props: { label: string }) {
  return <span className="row" role="status"><span className="spinner" aria-hidden="true" /><span>{props.label}</span></span>;
}

export function Empty(props: { children: ReactNode }) {
  return <div className="empty">{props.children}</div>;
}

/** Button that, when disabled, always states why (visible text, linked by aria-describedby). */
export function ActionButton(props: {
  onClick: () => void; children: ReactNode; disabledReason?: string | null; busy?: boolean; tone?: 'primary' | 'danger' | 'default';
  small?: boolean; type?: 'button' | 'submit'; testId?: string;
}) {
  const id = useId();
  const disabled = Boolean(props.disabledReason) || props.busy;
  return (
    <span className="stack" style={{ gap: 2, display: 'inline-flex' }}>
      <button type={props.type ?? 'button'} className={`btn ${props.tone === 'primary' ? 'primary' : props.tone === 'danger' ? 'danger' : ''} ${props.small ? 'small' : ''}`}
        onClick={props.onClick} disabled={disabled} aria-describedby={props.disabledReason ? id : undefined} aria-busy={props.busy || undefined} data-testid={props.testId}>
        {props.busy && <span className="spinner" aria-hidden="true" />}
        {props.children}
      </button>
      {props.disabledReason && <span id={id} className="disabled-reason">{props.disabledReason}</span>}
    </span>
  );
}

export function ModeBadges(props: { modes: DisplayMode[]; detail?: string }) {
  if (!props.modes.length) return null;
  return (
    <span className="row" style={{ gap: 4 }} data-testid="mode-badges">
      {props.modes.map((m) => (
        <span key={m} className={`badge ${modeClass(m)}`} title={MODE_EXPLANATION[m]} aria-label={`Data mode: ${m}. ${MODE_EXPLANATION[m]}`}>
          {m === 'Recorded' ? '▶ ' : m === 'Fixture' ? '◆ ' : m === 'Degraded' ? '! ' : ''}{m}
        </span>
      ))}
      {props.detail && <span className="small" style={{ opacity: 0.85 }}>{props.detail}</span>}
    </span>
  );
}

/** Shows a domain rejection distinctly from a network/transport failure. */
export function ErrorBox(props: { error: DomainError; transport?: boolean; onRetry?: () => void; retryLabel?: string }) {
  const { error } = props;
  const title = props.transport ? 'Network problem' : error.code === 'STALE_REVISION' || error.code === 'CONFLICT' ? 'Conflict'
    : error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED' ? 'Not allowed' : error.code === 'UNSUPPORTED' ? 'Not supported' : 'Request rejected';
  return (
    <Alert tone={props.transport ? 'warn' : 'bad'} title={title}>
      <p>{error.message}</p>
      <p className="small muted">
        {props.transport ? 'The request may or may not have reached the server. Retrying reuses the same command ID, so it cannot apply twice.' : `Code ${error.code}${error.retryable ? ' (retryable)' : ''}.`}
      </p>
      {error.fieldErrors.length > 0 && <ul className="small">{error.fieldErrors.map((f) => <li key={f.path}><code>{f.path}</code>: {f.message}</li>)}</ul>}
      {props.onRetry && <button type="button" className="btn small" onClick={props.onRetry}>{props.retryLabel ?? 'Retry'}</button>}
    </Alert>
  );
}

/** Accessible inline definition (keyboard and touch friendly, unlike a hover tooltip). */
export function Explain(props: { label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span>
      <button type="button" className="btn ghost small" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}
        aria-label={props.label ? `Definition: ${props.label}` : 'Definition'} style={{ minHeight: 24, padding: '0 4px' }}>
        <span aria-hidden="true">{'ⓘ'}</span>
      </button>
      {open && <span id={id} role="note" className="small muted" style={{ display: 'block' }}>{props.children}</span>}
    </span>
  );
}

export function KV(props: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {props.items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}
