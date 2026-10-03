import { describe, expect, it } from 'vitest';
import { canonicalJson, CanonicalJsonError, sha256Hex } from '../../src/domain/canonical';
import { sha256Sync } from '../../src/fixture/sha256';

describe('canonicalJson', () => {
  it('sorts keys by code unit, keeps arrays and exact strings', () => {
    expect(canonicalJson({ b: 1, a: [3, 1], 'Z': '  x  ', é: 1 })).toBe('{"Z":"  x  ","a":[3,1],"b":1,"é":1}');
  });
  it('omits absent optional keys', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
  it.each([
    [{ a: NaN }], [{ a: Infinity }], [[1, undefined]], [{ a: 1n }], [{ a: new Map() }], [{ a: () => 1 }], [new Date(0)],
  ])('rejects %o', (v) => {
    expect(() => canonicalJson(v)).toThrow(CanonicalJsonError);
  });
  it('fixture sync sha256 equals WebCrypto', async () => {
    for (const s of ['', 'abc', 'é'.repeat(300), canonicalJson({ x: [1, 2, { y: 'z' }] })]) {
      expect(sha256Sync(s)).toBe(await sha256Hex(s));
    }
  });
});
