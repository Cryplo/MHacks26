/**
 * Canonical JSON (charter section 6): recursively sorted object keys by code-unit order,
 * array order preserved, exact strings, JSON.stringify numbers, no whitespace. Absent
 * optional keys (undefined values in objects) are omitted; undefined array members,
 * non-finite numbers, BigInt, Map, Set, functions and non-plain objects are rejected.
 */
export class CanonicalJsonError extends Error {
  override name = 'CanonicalJsonError';
}

export function canonicalJson(value: unknown): string {
  return encode(value, '$');
}

function encode(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`${path}: non-finite number`);
      return JSON.stringify(value);
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      throw new CanonicalJsonError(`${path}: unsupported ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v, i) => {
      if (v === undefined) throw new CanonicalJsonError(`${path}[${i}]: undefined array member`);
      return encode(v, `${path}[${i}]`);
    }).join(',')}]`;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new CanonicalJsonError(`${path}: non-plain object`);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort(compareCodeUnits);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${encode(obj[k], `${path}.${k}`)}`).join(',')}}`;
}

/** Code-unit (UTF-16) order, which is what Array.prototype.sort uses for strings. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === 'string' ? utf8(bytes) : bytes;
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return toHex(new Uint8Array(digest));
}

export const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const canonicalHash = (value: unknown) => sha256Hex(canonicalJson(value));
