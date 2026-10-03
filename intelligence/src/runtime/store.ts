import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Small durable key-value port. `putIfAbsent` is the write-once primitive: the first value for a
 * key wins and every later caller receives the winner.
 *
 * Concurrency assumptions: `FileStore` is safe for ONE worker process per data directory (atomic
 * temp-file + rename for overwrites, hard-link creation for write-once). It is not a distributed
 * lock; several worker processes need a shared transactional store before they can share a cache.
 */
export interface DurableStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  putIfAbsent(key: string, value: Uint8Array): Promise<{ created: boolean; value: Uint8Array }>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

const KEY_RE = /^[A-Za-z0-9_.:\-/]{1,400}$/;
function checkKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes('..') || key.startsWith('/')) throw new Error(`invalid store key ${key}`);
}

export class MemoryStore implements DurableStore {
  readonly data = new Map<string, Uint8Array>();
  async get(key: string) { checkKey(key); const v = this.data.get(key); return v ? new Uint8Array(v) : null; }
  async put(key: string, value: Uint8Array) { checkKey(key); this.data.set(key, new Uint8Array(value)); }
  async putIfAbsent(key: string, value: Uint8Array) {
    checkKey(key);
    const prior = this.data.get(key);
    if (prior) return { created: false, value: new Uint8Array(prior) };
    this.data.set(key, new Uint8Array(value));
    return { created: true, value: new Uint8Array(value) };
  }
  async delete(key: string) { checkKey(key); this.data.delete(key); }
  async list(prefix: string) { return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort(); }
}

export class FileStore implements DurableStore {
  constructor(readonly root: string) {}

  private path(key: string): string { checkKey(key); return join(this.root, ...key.split('/')); }

  async get(key: string): Promise<Uint8Array | null> {
    try { return new Uint8Array(await fs.readFile(this.path(key))); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  private async writeTemp(path: string, value: Uint8Array): Promise<string> {
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${randomUUID()}`;
    const fh = await fs.open(tmp, 'wx');
    try { await fh.writeFile(value); await fh.sync(); } finally { await fh.close(); }
    return tmp;
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    const path = this.path(key);
    const tmp = await this.writeTemp(path, value);
    await fs.rename(tmp, path);
  }

  async putIfAbsent(key: string, value: Uint8Array): Promise<{ created: boolean; value: Uint8Array }> {
    const path = this.path(key);
    const tmp = await this.writeTemp(path, value);
    try {
      await fs.link(tmp, path);
      return { created: true, value };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      return { created: false, value: new Uint8Array(await fs.readFile(path)) };
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  async delete(key: string): Promise<void> { await fs.rm(this.path(key), { force: true }); }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, rel: string) => {
      let entries: Dirent[];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.includes('.tmp-')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), r);
        else if (r.startsWith(prefix)) out.push(r);
      }
    };
    await walk(this.root, '');
    return out.sort();
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export const jsonBytes = (v: unknown) => enc.encode(JSON.stringify(v));
export const parseJson = <T>(b: Uint8Array): T => JSON.parse(dec.decode(b)) as T;

export async function getJson<T>(s: DurableStore, key: string): Promise<T | null> {
  const b = await s.get(key);
  return b ? parseJson<T>(b) : null;
}
export async function putJson(s: DurableStore, key: string, v: unknown): Promise<void> { await s.put(key, jsonBytes(v)); }
