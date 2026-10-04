import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { DomainError } from '../../contract/behavior-v1';
import { MODE_EXPLANATION, modeClass, type DisplayMode } from '../runtime/mode';
import { useRuntime } from '../runtime/RuntimeProvider';

export function Panel(props: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; labelledBy?: string; as?: 'section' | 'div' | 'aside'; testId?: string }) {
  const id = useId();
  const Tag = props.as ?? 'section';
  return (
    <Tag className={`panel ${props.className ?? ''}`} aria-labelledby={props.title ? id : props.labelledBy} data-testid={props.testId}>
      {(props.title || props.actions) && (
        <header>
          {props.title && <h2 id={id}>{props.title}</h2>}
          {props.actions && <div className="row" style={{ gap: 8 }}>{props.actions}</div>}
        </header>
      )}
      {props.children}
    </Tag>
  );
}

export function Alert(props: { tone: 'info' | 'ok' | 'warn' | 'bad'; title?: ReactNode; children?: ReactNode; role?: 'alert' | 'status' }) {
  const icon = { info: 'i', ok: '✓', warn: '!', bad: '!' }[props.tone];
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
  return <span className="row muted" style={{ gap: 8 }} role="status"><span className="spinner" aria-hidden="true" /><span>{props.label}</span></span>;
}

export function Empty(props: { children: ReactNode }) {
  return <div className="empty">{props.children}</div>;
}

/** Button that, when disabled, always states why (visible text, linked by aria-describedby). */
export function ActionButton(props: {
  onClick: () => void; children: ReactNode; disabledReason?: string | null; busy?: boolean; tone?: 'primary' | 'danger' | 'default' | 'ghost';
  small?: boolean; large?: boolean; block?: boolean; type?: 'button' | 'submit'; testId?: string; hideReason?: boolean; className?: string; ariaLabel?: string;
}) {
  const id = useId();
  const disabled = Boolean(props.disabledReason) || props.busy;
  const cls = ['btn', props.tone && props.tone !== 'default' ? props.tone : '', props.small ? 'small' : '', props.large ? 'large' : '', props.block ? 'block' : '', props.className ?? ''].filter(Boolean).join(' ');
  const button = (
    <button type={props.type ?? 'button'} className={cls} onClick={props.onClick} disabled={disabled} aria-label={props.ariaLabel}
      aria-describedby={props.disabledReason ? id : undefined} aria-busy={props.busy || undefined} data-testid={props.testId} title={props.hideReason ? props.disabledReason ?? undefined : undefined}>
      {props.busy && <span className="spinner" aria-hidden="true" />}
      {props.children}
    </button>
  );
  if (!props.disabledReason) return <span style={{ display: props.block ? 'flex' : 'inline-flex', flexDirection: 'column' }}>{button}</span>;
  return (
    <span style={{ display: props.block ? 'flex' : 'inline-flex', flexDirection: 'column', gap: 6 }}>
      {button}
      <span id={id} className={props.hideReason ? 'sr-only' : 'disabled-reason'}>{props.disabledReason}</span>
    </span>
  );
}

export function ModeBadges(props: { modes: DisplayMode[]; detail?: string }) {
  if (!props.modes.length) return null;
  return (
    <span className="row" style={{ gap: 6 }} data-testid="mode-badges">
      {props.modes.map((m) => (
        <span key={m} className={`badge ${modeClass(m)}`} title={MODE_EXPLANATION[m]} aria-label={`Data mode: ${m}. ${MODE_EXPLANATION[m]}`}>{m}</span>
      ))}
      {props.detail && <span className="small muted">{props.detail}</span>}
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
      <p className="tiny faint">
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
      <button type="button" className="btn ghost small icon" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}
        aria-label={props.label ? `Definition: ${props.label}` : 'Definition'} style={{ height: 20, width: 20, verticalAlign: 'middle' }}>
        <Icon name="info" size={13} />
      </button>
      {open && <span id={id} role="note" className="note" style={{ display: 'block', marginTop: 2 }}>{props.children}</span>}
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

/** Collapsible section for provenance, caveats and advanced settings: available, not leading. */
export function Disclosure(props: { summary: ReactNode; count?: ReactNode; children: ReactNode; defaultOpen?: boolean; testId?: string }) {
  return (
    <details className="disclosure" open={props.defaultOpen} data-testid={props.testId}>
      <summary>{props.summary}{props.count !== undefined && <span className="count">{props.count}</span>}</summary>
      <div className="body">{props.children}</div>
    </details>
  );
}

type IconName = 'play' | 'pause' | 'back' | 'more' | 'close' | 'search' | 'share' | 'flask' | 'chart' | 'replay' | 'stop' | 'plus' | 'info' | 'list' | 'download' | 'step-back' | 'step-forward' | 'skip-back' | 'print' | 'arrow-right';
const PATHS: Record<IconName, ReactNode> = {
  play: <path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none" />,
  pause: <><rect x="4" y="3.5" width="2.6" height="9" rx="0.6" fill="currentColor" stroke="none" /><rect x="9.4" y="3.5" width="2.6" height="9" rx="0.6" fill="currentColor" stroke="none" /></>,
  back: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  more: <><circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" /><circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" /></>,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  search: <><circle cx="7" cy="7" r="4.25" /><path d="m10.2 10.2 3.3 3.3" /></>,
  share: <><path d="M8 2.5v8" /><path d="M5 5.5 8 2.5l3 3" /><path d="M3.5 9v3.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V9" /></>,
  flask: <><path d="M6 2.5h4" /><path d="M6.75 2.5v3.8L3.4 12.2a.9.9 0 0 0 .8 1.3h7.6a.9.9 0 0 0 .8-1.3L9.25 6.3V2.5" /><path d="M4.9 10h6.2" /></>,
  chart: <><path d="M2.5 13.5h11" /><path d="M4.5 11V8M8 11V4.5M11.5 11V6.5" /></>,
  replay: <><path d="M3 8a5 5 0 1 0 1.6-3.7" /><path d="M3 2.8v2.6h2.6" /></>,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.2" />,
  plus: <path d="M8 3v10M3 8h10" />,
  info: <><circle cx="8" cy="8" r="5.75" /><path d="M8 7.2v3.6" /><circle cx="8" cy="5.1" r="0.5" fill="currentColor" stroke="none" /></>,
  list: <path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01" />,
  download: <><path d="M8 2.5v8" /><path d="M5 7.5l3 3 3-3" /><path d="M3 13.5h10" /></>,
  'step-back': <><path d="M4 3.5v9" /><path d="M12 3.5v9L6 8z" fill="currentColor" stroke="none" /></>,
  'step-forward': <><path d="M12 3.5v9" /><path d="M4 3.5v9L10 8z" fill="currentColor" stroke="none" /></>,
  'skip-back': <><path d="M3.5 3.5v9" /><path d="M13 3.5v9L6.5 8z" fill="currentColor" stroke="none" /></>,
  print: <><path d="M4.5 6V2.5h7V6" /><rect x="2.5" y="6" width="11" height="5" rx="1" /><path d="M4.5 9.5h7v4h-7z" /></>,
  'arrow-right': <path d="M3 8h10M9 4l4 4-4 4" />,
};
export function Icon(props: { name: IconName; size?: number }) {
  const s = props.size ?? 16;
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[props.name]}
    </svg>
  );
}

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 22 22" aria-hidden="true">
      <rect x="0.5" y="0.5" width="21" height="21" rx="6" fill="#14181d" stroke="#2c343e" />
      <circle cx="11" cy="11" r="6" fill="none" stroke="#f0b43c" strokeOpacity="0.35" />
      <circle cx="11" cy="11" r="3" fill="#f0b43c" />
    </svg>
  );
}

export function Brand(props: { compact?: boolean }) {
  return (
    <Link to="/" className="brand" aria-label="Harbor Lights home">
      <BrandMark />
      <span>Harbor Lights</span>
      {!props.compact && <small>Behavior Engine</small>}
    </Link>
  );
}

/** Quiet but always-present data-source marker for the fixture profile. */
export function FixtureChip() {
  const rt = useRuntime();
  if (rt.settings.profile !== 'fixture') return null;
  return (
    <span className="fixture-chip" role="note" data-testid="fixture-banner" tabIndex={0}
      title="Fixture profile: scripted data with no Engine, no Jev and no backend. Guests follow a pre-scripted choreography and do not react to what-if changes.">
      Fixture data
      <span className="sr-only">: scripted data with no Engine, no Jev and no backend. Guests follow a pre-scripted choreography and do not react to what-if changes.</span>
    </span>
  );
}

/** A small popover menu: one trigger, items rendered only while open; Escape and outside click close it. */
export function Menu(props: { label: string; trigger: ReactNode; children: (close: () => void) => ReactNode; testId?: string; triggerClassName?: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); wrap.current?.querySelector<HTMLButtonElement>('button')?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    wrap.current?.querySelector<HTMLElement>('[role=menu] button, [role=menu] a')?.focus();
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const close = () => setOpen(false);
  return (
    <div className="menu-wrap" ref={wrap}>
      <button type="button" className={props.triggerClassName ?? 'btn'} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-label={props.label} onClick={() => setOpen((o) => !o)} data-testid={props.testId}>
        {props.trigger}
      </button>
      {open && <div className="menu" role="menu" id={id} aria-label={props.label}>{props.children(close)}</div>}
    </div>
  );
}
