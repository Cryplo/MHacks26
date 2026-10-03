/**
 * Narration for ONE evidence record. Requests are keyed by (runId, evidenceId, agentId); a
 * result is accepted only if that key is still the current selection, so a slow narration
 * for guest A can never appear under guest B's card.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DomainError, Id, Narrative } from '../../../contract/behavior-v1';
import { narrativeSchema, validate } from '../../domain/schemas';
import type { CommandRunner } from '../../runtime/commands';
import { classifyError } from '../../runtime/errors';
import { awaitWork } from '../../runtime/work';
import type { RuntimeClient } from '../../../contract/behavior-v1';

export type NarrationState =
  | { kind: 'idle' }
  | { kind: 'loading'; key: string }
  | { kind: 'ready'; key: string; narrative: Narrative }
  | { kind: 'failed'; key: string; error: DomainError };

export const narrationKey = (runId: Id, evidenceId: Id, agentId: Id) => `${runId}|${evidenceId}|${agentId}`;

export function useNarration(client: RuntimeClient, runner: CommandRunner, runId: Id, evidenceId: Id | null, agentId: Id) {
  const [state, setState] = useState<NarrationState>({ kind: 'idle' });
  const current = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const key = evidenceId ? narrationKey(runId, evidenceId, agentId) : null;

  useEffect(() => {
    // Selection changed: cancel any in-flight polling and clear the old card.
    current.current = key;
    abort.current?.abort();
    abort.current = null;
    setState({ kind: 'idle' });
  }, [key]);

  const request = useCallback(async () => {
    if (!evidenceId || !key) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setState({ kind: 'loading', key });
    const accept = (next: NarrationState) => { if (current.current === key && !ctrl.signal.aborted) setState(next); };
    const out = await runner.run('requestProductWork', { request: { kind: 'thought', runId, evidenceId, agentId } }, `thought:${key}:${Date.now()}`);
    if (out.kind !== 'accepted') { accept({ kind: 'failed', key, error: out.error }); return; }
    try {
      const status = await awaitWork<'thought'>(client, out.result.workId, { signal: ctrl.signal, intervalMs: 300, timeoutMs: 60_000 });
      if (status.status !== 'ready' || !status.result) {
        accept({ kind: 'failed', key, error: status.error ?? { code: 'INCOMPLETE', message: `Narration ${status.status}.`, retryable: true, fieldErrors: [] } });
        return;
      }
      const v = validate<Narrative>(narrativeSchema, status.result);
      if (!v.ok) { accept({ kind: 'failed', key, error: { code: 'INVALID_INPUT', message: `Narration failed validation: ${v.issues.join('; ')}`, retryable: false, fieldErrors: [] } }); return; }
      accept({ kind: 'ready', key, narrative: v.value });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      accept({ kind: 'failed', key, error: classifyError(e).error });
    }
  }, [client, runner, runId, evidenceId, agentId, key]);

  useEffect(() => () => abort.current?.abort(), []);
  return { state: state.kind !== 'idle' && 'key' in state && state.key !== key ? { kind: 'idle' as const } : state, request };
}
