import type { Clock } from '../runtime/clock.ts';

export type HttpRequest = { url: string; method: 'POST'; headers: Record<string, string>; body: string };
export type HttpResponse = { status: number; header: (name: string) => string | null; body: Uint8Array; truncated: boolean };

export class HttpAbort extends Error {
  constructor(readonly reason: 'timeout' | 'aborted' | 'too_large') { super(reason); this.name = 'HttpAbort'; }
}

export interface HttpPort {
  send(req: HttpRequest, opts: { signal: AbortSignal; timeoutMs: number; maxResponseBytes: number }): Promise<HttpResponse>;
}

/**
 * fetch-based transport with an operational-clock timeout and a hard response-size bound.
 * No retries here: the worker's inference layer is the only retry layer.
 */
export class FetchHttp implements HttpPort {
  constructor(private readonly clock: Clock, private readonly fetchImpl: typeof fetch = fetch) {}

  async send(req: HttpRequest, opts: { signal: AbortSignal; timeoutMs: number; maxResponseBytes: number }): Promise<HttpResponse> {
    if (opts.signal.aborted) throw new HttpAbort('aborted');
    const ac = new AbortController();
    let reason: HttpAbort['reason'] | null = null;
    const onAbort = () => { reason ??= 'aborted'; ac.abort(); };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    const timer = new AbortController();
    void this.clock.sleep(opts.timeoutMs, timer.signal).then(() => { reason ??= 'timeout'; ac.abort(); }, () => undefined);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, signal: ac.signal, redirect: 'error' });
      } catch (e) {
        if (reason) throw new HttpAbort(reason);
        throw e;
      }
      const declared = Number(res.headers.get('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > opts.maxResponseBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new HttpAbort('too_large');
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      let truncated = false;
      const reader = res.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > opts.maxResponseBytes) { await reader.cancel().catch(() => undefined); throw new HttpAbort('too_large'); }
            chunks.push(value);
          }
        } catch (e) {
          if (e instanceof HttpAbort) throw e;
          if (reason) throw new HttpAbort(reason);
          truncated = true;
        }
      }
      const body = new Uint8Array(size);
      let off = 0;
      for (const c of chunks) { body.set(c, off); off += c.byteLength; }
      return { status: res.status, header: (n) => res.headers.get(n), body, truncated };
    } finally {
      timer.abort();
      opts.signal.removeEventListener('abort', onAbort);
    }
  }
}
