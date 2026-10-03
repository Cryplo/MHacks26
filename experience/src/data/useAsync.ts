import { useCallback, useEffect, useRef, useState } from 'react';
import type { DomainError } from '../../contract/behavior-v1';
import { classifyError } from '../runtime/errors';

export type AsyncState<T> = { data: T | null; error: DomainError | null; transport: boolean; loading: boolean; reload: () => void };

/** Loads data; ignores results from superseded requests (deps changed / unmounted). */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], opts: { pollMs?: number; enabled?: boolean } = {}): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<{ e: DomainError; transport: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const gen = useRef(0);
  const enabled = opts.enabled ?? true;
  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    const my = ++gen.current;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      fn().then((d) => {
        if (my !== gen.current) return;
        setData(d); setError(null); setLoading(false);
      }, (e: unknown) => {
        if (my !== gen.current) return;
        const c = classifyError(e);
        setError({ e: c.error, transport: c.transport }); setLoading(false);
      }).finally(() => {
        if (my === gen.current && opts.pollMs) timer = setTimeout(run, opts.pollMs);
      });
    };
    setLoading(true);
    run();
    // Bumping the generation in cleanup is the point: it invalidates in-flight results.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { gen.current++; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, enabled, opts.pollMs]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error: error?.e ?? null, transport: error?.transport ?? false, loading, reload };
}
