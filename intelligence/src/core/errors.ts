import type { DomainError, RuntimeClientError } from '../../contract/behavior-v1.ts';

export type FieldError = { path: string; message: string };

export function domainError(
  code: DomainError['code'], message: string, retryable = false, fieldErrors: FieldError[] = [],
): DomainError {
  return { code, message, retryable, fieldErrors };
}

export function invalid(message: string, fieldErrors: FieldError[] = []): DomainError {
  return domainError('INVALID_INPUT', message, false, fieldErrors);
}

export function isRuntimeClientError(value: unknown): value is RuntimeClientError {
  return value instanceof Error && value.name === 'RuntimeClientError'
    && typeof (value as RuntimeClientError).transport === 'boolean'
    && typeof (value as RuntimeClientError).error === 'object';
}

export function runtimeClientError(error: DomainError, transport: boolean): RuntimeClientError {
  const e = new Error(error.message) as RuntimeClientError;
  Object.assign(e, { name: 'RuntimeClientError', error, transport });
  return e;
}

/** Result type for pure validation: value or field errors, never a throw. */
export type Validated<T> = { ok: true; value: T; warnings: string[] } | { ok: false; errors: FieldError[] };

export function ok<T>(value: T, warnings: string[] = []): Validated<T> {
  return { ok: true, value, warnings };
}

export function fail<T = never>(errors: FieldError[]): Validated<T> {
  return { ok: false, errors };
}

const SECRET_PATTERNS: RegExp[] = [
  /\bjv_(?:live|test)_[A-Za-z0-9_-]+/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk|pk|ts)-[A-Za-z0-9_-]{12,}/g,
];

/** Remove credential-shaped substrings and any explicitly registered secret values before logging. */
export function sanitize(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[REDACTED]');
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[REDACTED]');
  return out;
}
