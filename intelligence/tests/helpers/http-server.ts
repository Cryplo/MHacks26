import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Hit = { headers: IncomingMessage['headers']; body: string };
export type Responder = (hit: Hit, n: number, res: ServerResponse) => void;

/** Loopback fake HTTP server for deterministic provider failure tests (never the real provider). */
export async function fakeHttp(responder: Responder) {
  const hits: Hit[] = [];
  const open = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const hit = { headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      hits.push(hit);
      open.add(res);
      res.on('close', () => open.delete(res));
      responder(hit, hits.length, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/systemone`, hits,
    close: async () => {
      for (const r of open) r.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(text);
}
