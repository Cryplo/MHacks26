import type * as C from "../contract/behavior-v1.js";
import { DbConnection } from "./generated/index.js";
import { canonical, hash, hashBytes } from "../src/domain/primitives.js";
import { encodeBase64, decodeBase64 } from "../src/navigation/grid.js";
const MAX_CHUNK_BYTES = 48 * 1024;
export class RuntimeClientError extends Error implements C.RuntimeClientError {
  override name = "RuntimeClientError" as const;
  constructor(
    readonly error: C.DomainError,
    readonly transport: boolean,
  ) {
    super(error.message);
  }
}
function transportError(message: string) {
  return new RuntimeClientError(
    {
      code: "DEPENDENCY_UNAVAILABLE",
      message,
      retryable: true,
      fieldErrors: [],
    },
    true,
  );
}
type LiveHandlers = Parameters<C.RuntimeClient["subscribeLive"]>[1];
type Pending = {
  id: string;
  kind: string;
  name: string;
  payload: string;
  digest: string;
  resolve: (x: C.Receipt<unknown>) => void;
  reject: (e: Error) => void;
  deadline: ReturnType<typeof setTimeout>;
  retry: ReturnType<typeof setInterval>;
};
export async function createRuntimeClient(
  config: C.RuntimeConfig,
): Promise<C.RuntimeClient> {
  const client = new Client(config);
  await client.connect();
  return client;
}
export class Client implements C.RuntimeClient {
  readonly contractVersion = "behavior.v1" as const;
  private connection: DbConnection | null = null;
  private token: string | null;
  private pending = new Map<string, Pending>();
  private live = new Map<string, Set<LiveHandlers>>();
  private previous = new Map<LiveHandlers, C.LiveSnapshot>();
  private work = new Set<{ kinds: C.WorkKind[]; wake: () => void }>();
  private closed = false;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private config: C.RuntimeConfig) {
    this.token = config.token;
  }
  connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(transportError("Connection deadline exceeded")),
        10000,
      );
      let builder = DbConnection.builder()
        .withUri(this.config.uri)
        .withDatabaseName(this.config.database)
        .onConnect((connection, _identity, token) => {
          if (this.closed) {
            connection.disconnect();
            return;
          }
          this.connection = connection;
          this.token = token;
          this.config.onToken?.(token);
          const replies = () => this.flushReplies(),
            live = () => this.flushLive(),
            work = () => {
              for (const w of this.work)
                if (
                  [...connection.db.workAvailable.iter()].some(
                    (r) =>
                      w.kinds.includes(r.kind as C.WorkKind) && r.count > 0,
                  )
                )
                  w.wake();
            };
          connection.db.myReplies.onInsert(replies);
          connection.db.myReplies.onUpdate(replies);
          connection.db.liveRuns.onInsert(live);
          connection.db.liveRuns.onUpdate(live);
          connection.db.liveRuns.onDelete(live);
          connection.db.workAvailable.onInsert(work);
          connection.db.workAvailable.onUpdate(work);
          connection
            .subscriptionBuilder()
            .onApplied(() => {
              clearTimeout(timeout);
              this.connecting = null;
              this.previous.clear();
              this.flushReplies();
              this.flushLive();
              work();
              for (const set of this.live.values())
                for (const h of set) h.status("live");
              for (const p of this.pending.values()) this.send(p);
              resolve();
            })
            .onError((ctx) => {
              clearTimeout(timeout);
              reject(transportError(String(ctx.event)));
            })
            .subscribe([
              "SELECT * FROM my_replies",
              "SELECT * FROM live_runs",
              "SELECT * FROM work_available",
            ]);
        })
        .onConnectError((_ctx, error) => {
          clearTimeout(timeout);
          this.connecting = null;
          reject(transportError(String(error)));
        })
        .onDisconnect(() => {
          this.connection = null;
          this.connecting = null;
          if (this.closed) return;
          for (const set of this.live.values())
            for (const h of set) h.status("reconnecting");
          this.reconnectTimer = setTimeout(() => {
            void this.connect().catch(() => this.scheduleReconnect());
          }, 500);
        });
      if (this.token) builder = builder.withToken(this.token);
      builder.build();
    });
    return this.connecting;
  }
  private scheduleReconnect() {
    if (this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      void this.connect().catch(() => this.scheduleReconnect());
    }, 1000);
  }
  private send(p: Pending) {
    if (!this.connection) return;
    void this.connection.reducers
      .invoke({ id: p.id, kind: p.kind, name: p.name, payload: p.payload })
      .catch((e) => {
        const active = this.pending.get(p.id);
        if (active) {
          this.clearPending(active);
          active.reject(transportError(`Reducer failed: ${String(e)}`));
        }
      });
  }
  private clearPending(p: Pending) {
    clearTimeout(p.deadline);
    clearInterval(p.retry);
    this.pending.delete(p.id);
  }
  private flushReplies() {
    if (!this.connection) return;
    for (const row of this.connection.db.myReplies.iter()) {
      const p = this.pending.get(row.id);
      if (p && p.digest === row.digest) {
        this.clearPending(p);
        try {
          p.resolve(JSON.parse(row.body));
        } catch {
          p.reject(transportError("Malformed runtime reply"));
        }
      }
    }
  }
  private flushLive() {
    if (!this.connection) return;
    const rows = new Map(
      [...this.connection.db.liveRuns.iter()].map((r) => [r.runId, r]),
    );
    for (const [runId, handlers] of this.live) {
      const row = rows.get(runId);
      for (const h of handlers) {
        const old = this.previous.get(h);
        if (!row) {
          if (old) {
            this.previous.delete(h);
            h.error({
              code: "FORBIDDEN",
              message: "Run subscription access revoked",
              retryable: false,
              fieldErrors: [],
            });
          }
          continue;
        }
        const next = JSON.parse(row.body) as C.LiveSnapshot;
        if (old && next.run.revision <= old.run.revision) continue;
        if (!old || next.run.revision !== old.run.revision + 1)
          h.snapshot(next);
        else {
          const ids = new Set(next.agents.map((a) => a.agentId)),
            last = old.recentEvents.at(-1)?.sequence ?? 0;
          h.patch({
            runId,
            fromRevision: old.run.revision,
            toRevision: next.run.revision,
            run: next.run,
            agents: {
              upsert: next.agents,
              removeIds: old.agents
                .filter((a) => !ids.has(a.agentId))
                .map((a) => a.agentId),
            },
            places: next.places,
            queues: next.queues,
            metrics: next.metrics,
            health: next.health,
            appendedEvents: next.recentEvents.filter((e) => e.sequence > last),
          });
        }
        this.previous.set(h, next);
      }
    }
  }
  async wire(
    kind: string,
    name: string,
    input: unknown,
    id: string = globalThis.crypto.randomUUID(),
  ): Promise<C.Receipt<unknown>> {
    if (this.closed) throw transportError("Client closed");
    const payload = canonical(input),
      digest = hash({ kind, name, payload });
    const active = this.pending.get(id);
    if (active) throw transportError("Request ID already in flight");
    return new Promise((resolve, reject) => {
      const p: Pending = {
        id,
        kind,
        name,
        payload,
        digest,
        resolve,
        reject,
        deadline: setTimeout(() => {
          this.clearPending(p);
          reject(
            transportError(
              "Receipt deadline exceeded; retry the same command ID",
            ),
          );
        }, 30000),
        retry: setInterval(() => this.send(p), 5000),
      };
      this.pending.set(id, p);
      this.flushReplies();
      if (this.pending.has(id)) this.send(p);
    });
  }
  async command<K extends keyof C.Commands>(
    name: K,
    input: C.Commands[K]["input"],
    commandId: string,
  ): Promise<C.Receipt<C.Commands[K]["output"]>> {
    return (await this.wire("command", name, input, commandId)) as C.Receipt<
      C.Commands[K]["output"]
    >;
  }
  async query<K extends keyof C.Queries>(
    name: K,
    input: C.Queries[K]["input"],
  ): Promise<C.Queries[K]["output"]> {
    const r = await this.wire("query", name, input);
    if (!r.ok) throw new RuntimeClientError(r.error, false);
    return r.result as C.Queries[K]["output"];
  }
  subscribeLive(runId: string, handlers: LiveHandlers): () => void {
    const set = this.live.get(runId) ?? new Set<LiveHandlers>();
    set.add(handlers);
    this.live.set(runId, set);
    handlers.status(this.connection ? "live" : "connecting");
    this.flushLive();
    return () => {
      set.delete(handlers);
      this.previous.delete(handlers);
      if (!set.size) this.live.delete(runId);
      handlers.status("closed");
    };
  }
  subscribeWorkAvailable(kinds: C.WorkKind[], wake: () => void): () => void {
    const entry = { kinds, wake };
    this.work.add(entry);
    wake();
    return () => {
      this.work.delete(entry);
    };
  }
  async putArtifact(
    input: Parameters<C.RuntimeClient["putArtifact"]>[0],
  ): Promise<C.ArtifactRef> {
    const id = `upload:${hash(input.commandId).slice(0, 48)}`;
    const result = await this.wire(
      "upload_begin",
      "",
      {
        id,
        kind: input.kind,
        mediaType: input.mediaType,
        scope: input.scope,
        byteLength: input.bytes.length,
        sha256: hashBytes(input.bytes),
      },
      `${input.commandId}:begin`,
    );
    if (!result.ok) throw new RuntimeClientError(result.error, false);
    for (let i = 0; i < Math.ceil(input.bytes.length / MAX_CHUNK_BYTES); i++) {
      const r = await this.wire(
        "upload_chunk",
        "",
        {
          id,
          index: i,
          base64: encodeBase64(
            input.bytes.slice(i * MAX_CHUNK_BYTES, (i + 1) * MAX_CHUNK_BYTES),
          ),
        },
        `${input.commandId}:chunk:${i}`,
      );
      if (!r.ok) throw new RuntimeClientError(r.error, false);
    }
    const r = await this.wire(
      "upload_finalize",
      "",
      { id },
      `${input.commandId}:final`,
    );
    if (!r.ok) throw new RuntimeClientError(r.error, false);
    return r.result as C.ArtifactRef;
  }
  async getArtifact(ref: C.ArtifactRef): Promise<Uint8Array> {
    const bytes = new Uint8Array(ref.byteLength);
    for (let i = 0; i < Math.ceil(ref.byteLength / MAX_CHUNK_BYTES); i++) {
      const r = await this.wire("artifact_chunk", "", { ref, index: i });
      if (!r.ok) throw new RuntimeClientError(r.error, false);
      bytes.set(
        decodeBase64((r.result as { base64: string }).base64),
        i * MAX_CHUNK_BYTES,
      );
    }
    if (hashBytes(bytes) !== ref.sha256)
      throw transportError("Artifact integrity mismatch");
    return bytes;
  }
  async close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const p of this.pending.values()) {
      this.clearPending(p);
      p.reject(transportError("Client closed"));
    }
    for (const set of this.live.values())
      for (const h of set) h.status("closed");
    this.live.clear();
    this.work.clear();
    this.previous.clear();
    this.connection?.disconnect();
    this.connection = null;
  }
}
