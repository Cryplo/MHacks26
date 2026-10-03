import type { DomainError, RuntimeClientError } from '../../contract/behavior-v1';

export function isRuntimeClientError(e: unknown): e is RuntimeClientError {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'RuntimeClientError'
    && typeof (e as { error?: unknown }).error === 'object' && typeof (e as { transport?: unknown }).transport === 'boolean';
}

export function makeRuntimeClientError(error: DomainError, transport: boolean): RuntimeClientError {
  const e = new Error(error.message) as RuntimeClientError;
  Object.assign(e, { name: 'RuntimeClientError' as const, error, transport });
  return e;
}

export const domainError = (code: DomainError['code'], message: string, retryable = false,
  fieldErrors: DomainError['fieldErrors'] = []): DomainError => ({ code, message, retryable, fieldErrors });

/** Normalizes anything thrown by the runtime into a classified error for display. */
export function classifyError(e: unknown): { error: DomainError; transport: boolean } {
  if (isRuntimeClientError(e)) return { error: e.error, transport: e.transport };
  const message = e instanceof Error ? e.message : String(e);
  return { error: domainError('INTERNAL', message), transport: false };
}

export const isAccessError = (code: DomainError['code']) => code === 'UNAUTHORIZED' || code === 'FORBIDDEN';
