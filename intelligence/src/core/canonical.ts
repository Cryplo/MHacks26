import { createHash } from 'node:crypto';
import type { Hash } from '../../contract/behavior-v1.ts';

export class CanonicalJsonError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} at ${path || '<root>'}`);
    this.name = 'CanonicalJsonError';
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encode(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError('non-finite number', path);
      return JSON.stringify(value);
    case 'bigint':
      throw new CanonicalJsonError('BigInt is not serializable', path);
    case 'undefined':
      throw new CanonicalJsonError('undefined value', path);
    case 'function':
    case 'symbol':
      throw new CanonicalJsonError(`${typeof value} is not serializable`, path);
    case 'object':
      break;
  }
  const obj = value as object;
  if (Array.isArray(obj)) {
    const parts: string[] = [];
    for (let i = 0; i < obj.length; i++) {
      if (!(i in obj) || obj[i] === undefined) throw new CanonicalJsonError('undefined array element', `${path}[${i}]`);
      parts.push(encode(obj[i], `${path}[${i}]`));
    }
    return `[${parts.join(',')}]`;
  }
  if (!isPlainObject(obj)) throw new CanonicalJsonError(`non-plain object (${obj.constructor?.name ?? 'unknown'})`, path);
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${encode(record[k], path ? `${path}.${k}` : k)}`).join(',')}}`;
}

/** Canonical JSON per shared charter section 6: sorted keys (code-unit order), no whitespace, absent optional keys omitted. */
export function canonicalJson(value: unknown): string {
  return encode(value, '');
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function sha256Hex(data: string | Uint8Array): Hash {
  return createHash('sha256').update(data).digest('hex');
}

export function hashCanonical(value: unknown): Hash {
  return sha256Hex(canonicalBytes(value));
}

export function isHash(value: unknown): value is Hash {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
