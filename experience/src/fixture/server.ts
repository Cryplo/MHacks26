/**
 * FIXTURE server: a scripted stand-in for Engine's durable command/receipt/authorization
 * surface so the product can be built and tested with no backend. Not a simulation engine:
 * guest motion comes from the finite scripted scene (scene.ts). State is persisted in a
 * Storage-like backend (localStorage in the browser) so tabs of one browser context share
 * one fixture "server", while each tab keeps its own session token.
 */
import type {
  ArtifactKind, ArtifactRef, Capabilities, Commands, CrowdSpec, DomainError, EventRecord, ExperimentReport, ExperimentSpec,
  Health, Id, LiveSnapshot, MetricSnapshot, ParkBundle, ParkSummary, PlaceView, PopulationManifest, ProductRequest, Queries,
  Quality, Receipt, Role, RunManifest, RunView, ScenarioEvent, Scenario, WaitDisplay, WorkStatus,
} from '../../contract/behavior-v1';
import { CONTRACT_VERSION } from '../../contract/behavior-v1';
import stage1 from '../../fixtures/parks/harbor-lights-stage1.bundle.json';
import stage2 from '../../fixtures/parks/harbor-lights-stage2.bundle.json';
import { canonicalJson, utf8 } from '../domain/canonical';
import { domainError } from '../runtime/errors';
import { buildFixturePopulation } from './population';
import { parseCrowdText, parseScenarioText } from './parsers';
import { experimentFactBundle, experimentReport, fixtureHash, heatmapFor, reportNarrative, runFactBundle, thoughtNarrative } from './reports';
import { agentViewAt, buildAppliedDecision, generateScene, metricsAt, predictedWaitAt, queueViewsAt, STEP_MS, type Scene } from './scene';
import { fixtureStatusText } from './rationale';
import { sha256Sync } from './sha256';

export const FIXTURE_OPERATOR_TOKEN = 'fixture-operator-local';
export const SCENE_MAX_HORIZON_MS = 4 * 3600_000;
export const BARRIER_SIM_MS = 20 * 60_000;
export const BARRIER_WALL_MS = 4000;
const PARKS = { 1: stage1 as unknown as ParkBundle, 2: stage2 as unknown as ParkBundle };

export type FixtureStorage = { read(): string | null; write(v: string): void };
export type FixtureFaults = {
  dropAck?: (keyof Commands)[]; // commit, then throw a transport error once per listed command
  failPopulation?: boolean;
  workDelayMs?: number;
  thoughtDelayMs?: number;
};

type Recipe =
  | { type: 'park'; stage: 1 | 2 }
  | { type: 'population'; crowd: CrowdSpec; parkArtifactId: Id };
type WorkRec = { workId: Id; kind: ProductRequest['kind']; request: ProductRequest; owner: string; createdAt: number; readyAt: number;
  result: unknown; error: DomainError | null };
type Control = { epoch: number; simMs: number; kind: 'start' | 'pause' | 'resume' | 'speed' | 'cancel'; speed: number };
type RunRec = { runId: Id; owner: string; manifest: RunManifest; manifestHash: string; createdAt: number; readyAt: number;
  control: Control[]; controlRevision: number; scenarioRevision: number; scheduled: (ScenarioEvent & { acceptedRevision: number })[] };
type GrantRec = { grantId: Id; runId: Id; access: 'viewer' | 'operator'; tokenHash: string; expiresAtEpochMs: number; revoked: boolean; issuer: string };
type ExpRec = { experimentId: Id; owner: string; spec: ExperimentSpec; createdAt: number; workId: Id };
type State = {
  v: 1; createdAt: number;
  receipts: Record<string, { payload: string; receipt: Receipt<unknown> }>;
  tokens: Record<string, string>; // token -> identity
  artifacts: Record<Id, { ref: ArtifactRef; recipe: Recipe; owner: string | null }>;
  works: Record<Id, WorkRec>; runs: Record<Id, RunRec>; grants: Record<Id, GrantRec>;
  bindings: Record<string, { runId: Id; role: 'viewer' | 'operator'; grantId: Id }[]>;
  experiments: Record<Id, ExpRec>; counters: { run: number; work: number; grant: number; exp: number; anon: number };
  thoughtTimes: Record<string, number>;
};

export class FixtureDomainError extends Error {
  constructor(readonly error: DomainError) { super(error.message); }
}
const fail = (code: DomainError['code'], message: string, retryable = false): never => { throw new FixtureDomainError(domainError(code, message, retryable)); };

export const FIXTURE_CAPABILITIES: Capabilities = {
  contractVersion: CONTRACT_VERSION,
  eventKinds: ['pass_price', 'board', 'notice', 'closure', 'app_message'],
  workKinds: ['population', 'parse_crowd', 'parse_scenario', 'thought', 'report'],
  features: { routeChoice: false, bumpReactions: false, splitGroups: false, speechBubbles: false, discountMessages: false },
  maxGuests: 2000, maxArtifactBytes: 8 * 1024 * 1024, maxChunkBytes: 256 * 1024,
};

const sceneCache = new Map<string, Scene>();
const popCache = new Map<string, PopulationManifest>();

export class FixtureServer {
  constructor(private readonly storage: FixtureStorage, private readonly now: () => number = () => Date.now(),
    readonly faults: FixtureFaults = {}) {}

  // ------------------------------------------------------------ persistence
  private load(): State {
    const raw = this.storage.read();
    if (raw) {
      try { const s = JSON.parse(raw) as State; if (s.v === 1) return s; } catch { /* reinitialize */ }
    }
    const s: State = { v: 1, createdAt: this.now(), receipts: {}, tokens: { [FIXTURE_OPERATOR_TOKEN]: 'fixture:operator' },
      artifacts: {}, works: {}, runs: {}, grants: {}, bindings: {}, experiments: {},
      counters: { run: 0, work: 0, grant: 0, exp: 0, anon: 0 }, thoughtTimes: {} };
    for (const stage of [1, 2] as const) {
      const ref = this.refFor('park', canonicalJson(PARKS[stage]));
      s.artifacts[ref.artifactId] = { ref, recipe: { type: 'park', stage }, owner: null };
    }
    this.storage.write(JSON.stringify(s));
    return s;
  }
  private mutate<T>(fn: (s: State) => T): T {
    const s = this.load();
    const out = fn(s);
    this.storage.write(JSON.stringify(s));
    return out;
  }
  private refFor(kind: ArtifactKind, body: string): ArtifactRef {
    const bytes = utf8(body);
    const sha = sha256Sync(bytes);
    return { artifactId: `art:${kind}:${sha.slice(0, 16)}`, kind, sha256: sha, byteLength: bytes.length, mediaType: 'application/json', contractVersion: CONTRACT_VERSION };
  }

  // ------------------------------------------------------------ identity
  /** Resolves a token to an identity; unknown/null tokens get a fresh anonymous identity. */
  connect(token: string | null): { identity: string; token: string } {
    return this.mutate((s) => {
      if (token && s.tokens[token]) return { identity: s.tokens[token]!, token };
      s.counters.anon++;
      const t = `fixture-anon-${s.counters.anon}-${sha256Sync(String(this.now()) + Math.random()).slice(0, 12)}`;
      s.tokens[t] = `fixture:anon:${s.counters.anon}`;
      return { identity: s.tokens[t]!, token: t };
    });
  }
  private isOperator = (identity: string) => identity === 'fixture:operator';
  private validBindings(s: State, identity: string) {
    return (s.bindings[identity] ?? []).filter((b) => {
      const g = s.grants[b.grantId];
      return g && !g.revoked && g.expiresAtEpochMs > this.now();
    });
  }
  private runRole(s: State, identity: string, runId: Id): 'operator' | 'viewer' | null {
    if (this.isOperator(identity)) return 'operator';
    const b = this.validBindings(s, identity).filter((x) => x.runId === runId);
    if (b.some((x) => x.role === 'operator')) return 'operator';
    return b.length ? 'viewer' : null;
  }
  private requireRun(s: State, identity: string, runId: Id, need: 'viewer' | 'operator'): RunRec {
    const run = s.runs[runId];
    const role = this.runRole(s, identity, runId);
    if (!role) {
      const hadGrant = (s.bindings[identity] ?? []).some((b) => b.runId === runId);
      fail('FORBIDDEN', hadGrant ? 'Your access to this run was revoked or has expired.' : 'You do not have access to this run.');
    }
    if (!run) return fail('NOT_FOUND', `Run ${runId} not found.`);
    if (need === 'operator' && role !== 'operator') fail('FORBIDDEN', 'Viewer access is read-only; this action needs operator rights for the run.');
    return run;
  }
  private requireOperator(identity: string) {
    if (!this.isOperator(identity)) fail('FORBIDDEN', 'This action needs an operator session.');
  }

  // ------------------------------------------------------------ commands
  command<K extends keyof Commands>(identity: string, name: K, input: Commands[K]['input'], commandId: Id): { receipt: Receipt<Commands[K]['output']>; dropAck: boolean } {
    const payload = canonicalJson({ name, input });
    const key = `${identity}|${commandId}`;
    const existing = this.load().receipts[key];
    if (existing) {
      if (existing.payload !== payload) {
        return { receipt: { commandId, ok: false, error: domainError('CONFLICT', 'This command ID was already used with a different payload.') }, dropAck: false };
      }
      return { receipt: existing.receipt as Receipt<Commands[K]['output']>, dropAck: false };
    }
    let receipt: Receipt<Commands[K]['output']>;
    try {
      const result = this.execute(identity, name, input, commandId) as Commands[K]['output'];
      receipt = { commandId, ok: true, result };
    } catch (e) {
      if (!(e instanceof FixtureDomainError)) throw e;
      receipt = { commandId, ok: false, error: e.error };
    }
    this.mutate((s) => { s.receipts[key] = { payload, receipt }; });
    const drop = this.faults.dropAck?.includes(name) ?? false;
    if (drop) this.faults.dropAck = this.faults.dropAck!.filter((n) => n !== name);
    return { receipt, dropAck: drop };
  }

  private execute(identity: string, name: keyof Commands, input: unknown, commandId: Id): unknown {
    switch (name) {
      case 'requestProductWork': return this.requestWork(identity, (input as Commands['requestProductWork']['input']).request);
      case 'createRun': return this.createRun(identity, (input as Commands['createRun']['input']).manifest, commandId);
      case 'startRun': return this.control(identity, (input as { runId: Id }).runId, 'start', null, null);
      case 'pauseRun': { const i = input as Commands['pauseRun']['input']; return this.control(identity, i.runId, 'pause', i.expectedControlRevision, null); }
      case 'resumeRun': { const i = input as Commands['resumeRun']['input']; return this.control(identity, i.runId, 'resume', i.expectedControlRevision, null); }
      case 'setSpeed': { const i = input as Commands['setSpeed']['input']; return this.control(identity, i.runId, 'speed', i.expectedControlRevision, i.requestedSpeed); }
      case 'cancelRun': { const i = input as Commands['cancelRun']['input']; return this.control(identity, i.runId, 'cancel', i.expectedControlRevision, null); }
      case 'scheduleEvents': return this.schedule(identity, input as Commands['scheduleEvents']['input']);
      case 'createExperiment': return this.createExperiment(identity, (input as Commands['createExperiment']['input']).spec);
      case 'issueShare': return this.issueShare(identity, input as Commands['issueShare']['input']);
      case 'redeemShare': return this.redeemShare(identity, (input as Commands['redeemShare']['input']).token);
      case 'revokeShare': return this.revokeShare(identity, (input as Commands['revokeShare']['input']).grantId);
      case 'registerPark': this.requireOperator(identity); return fail('UNSUPPORTED', 'The fixture ships pre-registered Harbor Lights parks; registration runs through Engine tooling.');
      default: return fail('FORBIDDEN', `${name} is a worker/coordinator command and is not available to this session.`);
    }
  }

  private requestWork(identity: string, request: ProductRequest): { workId: Id } {
    if (!FIXTURE_CAPABILITIES.workKinds.includes(request.kind)) fail('UNSUPPORTED', `${request.kind} work is not supported.`);
    return this.mutate((s) => {
      if (request.kind === 'thought') {
        this.requireRun(s, identity, request.runId, 'viewer');
        const last = s.thoughtTimes[identity] ?? 0;
        if (this.now() - last < 1500) fail('RATE_LIMITED', 'Narration requests are rate limited; try again in a moment.', true);
        s.thoughtTimes[identity] = this.now();
      } else if (request.kind === 'report') {
        if (request.runId) this.requireRun(s, identity, request.runId, 'viewer'); else this.requireOperator(identity);
      } else {
        this.requireOperator(identity);
      }
      s.counters.work++;
      const workId = `work-${s.counters.work}-${request.kind}`;
      const delay = request.kind === 'thought' ? (this.faults.thoughtDelayMs ?? 900) : (this.faults.workDelayMs ?? (request.kind === 'population' ? 1600 : 700));
      const rec: WorkRec = { workId, kind: request.kind, request, owner: identity, createdAt: this.now(), readyAt: this.now() + delay, result: null, error: null };
      try {
        rec.result = this.computeWork(s, request);
      } catch (e) {
        if (!(e instanceof FixtureDomainError)) throw e;
        rec.error = e.error;
      }
      s.works[workId] = rec;
      return { workId };
    });
  }

  private computeWork(s: State, r: ProductRequest): unknown {
    switch (r.kind) {
      case 'population': {
        if (this.faults.failPopulation) fail('DEPENDENCY_UNAVAILABLE', 'Fixture fault: population worker failed.', true);
        const park = s.artifacts[r.park.artifactId];
        if (!park || park.recipe.type !== 'park' || park.ref.sha256 !== r.park.sha256) fail('INVALID_INPUT', 'Unknown or mismatched park artifact.');
        const crowd = r.crowd;
        const total = Object.values(crowd.shares).reduce((a, b) => a + b, 0);
        if (!Number.isSafeInteger(crowd.guestCount) || crowd.guestCount < 1 || crowd.guestCount > FIXTURE_CAPABILITIES.maxGuests) fail('INVALID_INPUT', 'guestCount out of range.');
        if (Math.abs(total - 1) > 1e-6) fail('INVALID_INPUT', `Archetype shares must sum to 1 (got ${total}).`);
        const recipe: Recipe = { type: 'population', crowd, parkArtifactId: park!.ref.artifactId };
        const manifest = this.population(recipe, park!.ref.sha256);
        const ref = this.refFor('population', canonicalJson(manifest));
        s.artifacts[ref.artifactId] = { ref, recipe, owner: null };
        return { artifact: ref, guestCount: manifest.personas.length, groupCount: manifest.groups.length };
      }
      case 'parse_crowd': return parseCrowdText(r.text, r.current, FIXTURE_CAPABILITIES.maxGuests);
      case 'parse_scenario': {
        const ctx = this.scenarioContext(s, r.runId, r.park);
        if (r.expectedScenarioRevision !== ctx.scenarioRevision) fail('STALE_REVISION', `Scenario revision is ${ctx.scenarioRevision}; the draft request expected ${r.expectedScenarioRevision}.`);
        const park = this.parkFromRef(s, r.park);
        return parseScenarioText(r.text, ctx, park.openLocal, park.closeAfterMs);
      }
      case 'thought': {
        const run = s.runs[r.runId]!;
        const scene = this.scene(s, run);
        const ev = buildAppliedDecision(scene, r.evidenceId, run.runId);
        if (!ev) fail('NOT_FOUND', `Evidence ${r.evidenceId} not found.`);
        if (!ev!.request.agentIds.includes(r.agentId)) fail('INVALID_INPUT', 'That evidence does not govern this guest.');
        return thoughtNarrative(ev!, r.agentId);
      }
      case 'report': {
        if (r.runId) {
          const run = s.runs[r.runId]!;
          return reportNarrative(this.factBundleForRun(s, run), run.runId);
        }
        const exp = s.experiments[r.experimentId ?? ''];
        if (!exp) return fail('NOT_FOUND', 'Experiment not found.');
        return reportNarrative(experimentFactBundle(this.experimentReport(exp), exp.experimentId), exp.experimentId);
      }
    }
  }

  private population(recipe: Extract<Recipe, { type: 'population' }>, parkHash: string): PopulationManifest {
    const key = canonicalJson(recipe);
    let m = popCache.get(key);
    if (!m) {
      const park = this.parkByArtifact(recipe.parkArtifactId);
      m = buildFixturePopulation(recipe.crowd, park, parkHash).manifest;
      popCache.set(key, m);
    }
    return m;
  }
  private parkByArtifact(artifactId: Id): ParkBundle {
    const a = this.load().artifacts[artifactId];
    if (!a || a.recipe.type !== 'park') return fail('NOT_FOUND', 'Park artifact not found.');
    return PARKS[a.recipe.stage];
  }
  private parkFromRef(s: State, ref: ArtifactRef): ParkBundle {
    const a = s.artifacts[ref.artifactId];
    if (!a || a.recipe.type !== 'park') return fail('NOT_FOUND', 'Park artifact not found.');
    return PARKS[a.recipe.stage];
  }

  private createRun(identity: string, manifest: RunManifest, commandId: Id): { runId: Id } {
    this.requireOperator(identity);
    return this.mutate((s) => {
      if (manifest.contractVersion !== CONTRACT_VERSION) fail('INVALID_INPUT', 'Manifest contract version mismatch.');
      const park = s.artifacts[manifest.park.artifactId];
      const pop = s.artifacts[manifest.population.artifactId];
      if (!park || park.ref.sha256 !== manifest.park.sha256) fail('INVALID_INPUT', 'Unknown park artifact.');
      if (!pop || pop.ref.sha256 !== manifest.population.sha256 || pop.recipe.type !== 'population') fail('INVALID_INPUT', 'Unknown population artifact.');
      const c = manifest.config;
      if (c.mode !== 'mock') fail('UNSUPPORTED', `The fixture runtime cannot run ${c.mode} mode; it has no Jev or Engine connection.`);
      if (c.logicalStepMs !== 5000 || c.movementStepMs !== 250 || c.temperature !== 1) fail('INVALID_INPUT', 'Fixed step/temperature settings are required.');
      if (c.horizonMs > SCENE_MAX_HORIZON_MS || c.horizonMs % STEP_MS !== 0 || c.horizonMs <= 0) fail('UNSUPPORTED', `Fixture scenes cover at most ${SCENE_MAX_HORIZON_MS / 3600_000} hours on 5-second boundaries.`);
      for (const e of manifest.scenario.events) {
        if (!FIXTURE_CAPABILITIES.eventKinds.includes(e.change.kind)) fail('UNSUPPORTED', `${e.change.kind} events are not supported.`);
        if (e.atMs % STEP_MS !== 0) fail('INVALID_INPUT', `Event ${e.id} is not on a 5-second boundary.`);
      }
      s.counters.run++;
      const runId = `run-${s.counters.run}-${sha256Sync(identity + commandId).slice(0, 6)}`;
      s.runs[runId] = { runId, owner: identity, manifest, manifestHash: fixtureHash(manifest), createdAt: this.now(), readyAt: this.now() + 1500,
        control: [], controlRevision: 0, scenarioRevision: 1, scheduled: manifest.scenario.events.map((e) => ({ ...e, acceptedRevision: 1 })) };
      return { runId };
    });
  }

  private control(identity: string, runId: Id, kind: Control['kind'], expected: number | null, speed: number | null): RunView {
    return this.mutate((s) => {
      const run = this.requireRun(s, identity, runId, 'operator');
      const tl = this.timeline(run);
      if (expected !== null && expected !== run.controlRevision) fail('STALE_REVISION', `Control revision is ${run.controlRevision}; you sent ${expected}. Refresh and try again.`);
      if (kind === 'start') {
        if (run.control.length) fail('INVALID_STATE', 'Run already started.');
        if (this.now() < run.readyAt) fail('INVALID_STATE', 'Run is still preparing.', true);
        run.control.push({ epoch: this.now(), simMs: 0, kind, speed: run.manifest.config.requestedSpeed });
      } else {
        if (!run.control.length) fail('INVALID_STATE', 'Run has not started.');
        if (tl.status === 'completed' || tl.status === 'cancelled') fail('INVALID_STATE', `Run is ${tl.status}.`);
        if (kind === 'pause' && tl.status === 'paused') fail('INVALID_STATE', 'Run is already paused.');
        if (kind === 'resume' && tl.status !== 'paused') fail('INVALID_STATE', 'Run is not paused.');
        if (kind === 'speed' && (speed === null || !(speed > 0 && speed <= 120))) fail('INVALID_INPUT', 'Speed must be between 0 and 120.');
        const last = run.control[run.control.length - 1]!;
        run.control.push({ epoch: this.now(), simMs: tl.exactSimMs, kind, speed: kind === 'speed' ? speed! : last.speed });
      }
      run.controlRevision++;
      return this.runView(s, run);
    });
  }

  private schedule(identity: string, input: Commands['scheduleEvents']['input']) {
    return this.mutate((s) => {
      const run = this.requireRun(s, identity, input.runId, 'operator');
      if (run.manifest.experiment) fail('INVALID_STATE', 'This run is an experiment arm; its scenario is frozen. Create a new exploratory scenario or run instead.');
      if (input.expectedScenarioRevision !== String(run.scenarioRevision)) {
        fail('STALE_REVISION', `Scenario revision is now ${run.scenarioRevision} (you reviewed ${input.expectedScenarioRevision}). Review the refreshed draft.`);
      }
      const view = this.runView(s, run);
      if (view.status === 'completed' || view.status === 'cancelled' || view.status === 'failed') fail('INVALID_STATE', `Run is ${view.status}.`);
      if (!input.events.length) fail('INVALID_INPUT', 'No events to schedule.');
      for (const e of input.events) {
        if (!FIXTURE_CAPABILITIES.eventKinds.includes(e.change.kind)) fail('UNSUPPORTED', `${e.change.kind} events are not supported.`);
        if (!Number.isSafeInteger(e.atMs) || e.atMs % STEP_MS !== 0) fail('INVALID_INPUT', `Event ${e.id} must be on a 5-second boundary.`);
        if (e.atMs < view.earliestSchedulableMs) fail('CONFLICT', `Event ${e.id} at ${e.atMs} ms is before the earliest schedulable boundary (${view.earliestSchedulableMs} ms). Review a corrected draft.`);
        if (e.change.kind === 'app_message' && e.change.discount && !FIXTURE_CAPABILITIES.features.discountMessages) fail('UNSUPPORTED', 'Discount messages are not supported.');
        if (e.change.kind === 'pass_price' && (!Number.isSafeInteger(e.change.unitPriceCents) || e.change.unitPriceCents <= 0)) fail('INVALID_INPUT', 'Price must be positive integer cents.');
        if ('placeId' in e.change && !this.parkFromRef(s, run.manifest.park).places.some((p) => p.id === (e.change as { placeId: Id }).placeId)) fail('INVALID_INPUT', 'Unknown place.');
        if (run.scheduled.some((x) => x.id === e.id)) fail('CONFLICT', `Event id ${e.id} already scheduled.`);
      }
      run.scenarioRevision++;
      run.scheduled.push(...input.events.map((e) => ({ ...e, acceptedRevision: run.scenarioRevision })));
      return { scenarioRevision: String(run.scenarioRevision), events: input.events };
    });
  }

  private issueShare(identity: string, i: Commands['issueShare']['input']) {
    return this.mutate((s) => {
      const run = this.requireRun(s, identity, i.runId, 'operator');
      if (i.access === 'operator' && run.owner !== identity) fail('FORBIDDEN', 'Only the run owner can delegate operator access.');
      if (!/^[0-9a-f]{64}$/.test(i.tokenHash)) fail('INVALID_INPUT', 'tokenHash must be a SHA-256 hex digest.');
      if (i.expiresAtEpochMs <= this.now()) fail('INVALID_INPUT', 'Expiry must be in the future.');
      s.counters.grant++;
      const grantId = `grant-${s.counters.grant}`;
      s.grants[grantId] = { grantId, runId: i.runId, access: i.access, tokenHash: i.tokenHash, expiresAtEpochMs: i.expiresAtEpochMs, revoked: false, issuer: identity };
      return { grantId };
    });
  }
  private redeemShare(identity: string, token: string) {
    return this.mutate((s) => {
      const hash = sha256Sync(canonicalJson(token)); // same binding as Engine
      const g = Object.values(s.grants).find((x) => x.tokenHash === hash);
      if (!g) return fail('NOT_FOUND', 'This share link is not valid.');
      if (g.revoked) fail('FORBIDDEN', 'This share link was revoked.');
      if (g.expiresAtEpochMs <= this.now()) fail('FORBIDDEN', 'This share link has expired.');
      const list = (s.bindings[identity] ??= []);
      if (!list.some((b) => b.grantId === g.grantId)) list.push({ runId: g.runId, role: g.access, grantId: g.grantId });
      return { runId: g.runId, role: g.access };
    });
  }
  private revokeShare(identity: string, grantId: Id) {
    return this.mutate((s) => {
      const g = s.grants[grantId];
      if (!g) return fail('NOT_FOUND', 'Grant not found.');
      this.requireRun(s, identity, g.runId, 'operator');
      g.revoked = true;
      return { revoked: true };
    });
  }

  private createExperiment(identity: string, spec: ExperimentSpec) {
    this.requireOperator(identity);
    return this.mutate((s) => {
      if (spec.seeds.length < 1 || spec.seeds.length > 5) fail('INVALID_INPUT', 'Use 1-5 seeds.');
      if (spec.config.mode !== 'mock') fail('UNSUPPORTED', 'The fixture runtime can only script mock comparisons.');
      if (spec.config.horizonMs > SCENE_MAX_HORIZON_MS) fail('UNSUPPORTED', 'Fixture scenes cover at most 4 hours.');
      if (s.experiments[spec.experimentId]) fail('CONFLICT', 'Experiment ID already exists.');
      s.counters.work++;
      const workId = `work-${s.counters.work}-experiment`;
      s.experiments[spec.experimentId] = { experimentId: spec.experimentId, owner: identity, spec, createdAt: this.now(), workId };
      return { experimentId: spec.experimentId, workId };
    });
  }

  // ------------------------------------------------------------ queries
  query<K extends keyof Queries>(identity: string, name: K, input: Queries[K]['input']): Queries[K]['output'] {
    const s = this.load();
    const out = (v: unknown) => v as Queries[K]['output'];
    switch (name) {
      case 'capabilities': return out(FIXTURE_CAPABILITIES);
      case 'session': {
        const binds = this.validBindings(s, identity);
        const roles: Role[] = this.isOperator(identity) ? ['operator'] : [];
        if (binds.some((b) => b.role === 'viewer') && !roles.includes('viewer')) roles.push('viewer');
        if (binds.some((b) => b.role === 'operator') && !roles.includes('operator')) roles.push('operator');
        const runIds = this.isOperator(identity) ? Object.keys(s.runs) : [...new Set(binds.map((b) => b.runId))];
        return out({ identity, roles, runIds });
      }
      case 'listParks': {
        const parks: ParkSummary[] = Object.values(s.artifacts).filter((a) => a.recipe.type === 'park').map((a) => {
          const stage = (a.recipe as { stage: 1 | 2 }).stage;
          const b = PARKS[stage];
          const preparing = stage === 2 && this.now() - s.createdAt < 2500;
          return { parkId: b.parkId, revision: b.revision, label: b.label, artifact: a.ref, status: preparing ? 'preparing' : 'ready', issues: [] };
        });
        return out({ items: parks, nextCursor: null });
      }
      case 'getWork': {
        const w = s.works[(input as { workId: Id }).workId];
        if (!w) {
          const exp = Object.values(s.experiments).find((e) => e.workId === (input as { workId: Id }).workId);
          if (exp) return out({ workId: exp.workId, kind: 'experiment', status: 'leased', result: null, error: null });
          return fail('NOT_FOUND', 'Work not found.');
        }
        if (w.owner !== identity) fail('FORBIDDEN', 'Work belongs to another session.');
        const ready = this.now() >= w.readyAt;
        const status: WorkStatus = { workId: w.workId, kind: w.kind, status: !ready ? (this.now() - w.createdAt > 250 ? 'leased' : 'pending') : w.error ? 'failed' : 'ready',
          result: ready && !w.error ? w.result : null, error: ready ? w.error : null } as WorkStatus;
        return out(status);
      }
      case 'getRun': return out(this.runView(s, this.requireRun(s, identity, (input as { runId: Id }).runId, 'viewer')));
      case 'getManifest': return out(this.requireRun(s, identity, (input as { runId: Id }).runId, 'viewer').manifest);
      case 'getLiveSnapshot': return out(this.snapshot(s, this.requireRun(s, identity, (input as { runId: Id }).runId, 'viewer')));
      case 'getAgent': {
        const i = input as Queries['getAgent']['input'];
        const run = this.requireRun(s, identity, i.runId, 'viewer');
        const scene = this.scene(s, run);
        const t = this.timeline(run).committedSimMs;
        const persona = scene.personas.get(i.agentId);
        if (!persona) return fail('NOT_FOUND', 'Guest not found.');
        const agent = agentViewAt(scene, i.agentId, t) ?? { ...agentViewAt(scene, i.agentId, Math.max(0, t - STEP_MS))!, state: 'left' as const };
        const decisions = scene.decisionsByGroup.get(persona.groupId)!.filter((d) => d.atMs <= t);
        const last = decisions[decisions.length - 1];
        const group = scene.groups.get(persona.groupId)!;
        // Additive AgentDetail fields, as Engine provides them: newest-first decision history with
        // rationale, and a plain-language status line.
        const history = decisions.slice(-12).reverse().flatMap((d) => {
          const e = buildAppliedDecision(scene, d.evidenceId, run.runId);
          const chosen = e?.request.options.find((o) => o.id === e.chosenOptionId);
          return e?.rationale ? [{ evidenceId: e.evidenceId, atMs: e.committedAtMs, moment: e.request.moment, chosenOptionId: e.chosenOptionId,
            chosenLabel: chosen?.label ?? e.chosenOptionId, outcome: e.outcome, source: e.response.source, rationale: e.rationale }] : [];
        });
        const party = (scene.partiesByGroup.get(persona.groupId) ?? []).find((pa) => pa.joinT <= t && t < pa.leaveT);
        const placeName = (id: string | null) => (id ? scene.geo.places.get(id)?.name ?? id : null);
        const statusText = fixtureStatusText(agentViewAt(scene, i.agentId, t), placeName, {
          arrivesInMs: group.arrivalMs - t,
          queueMinutes: party ? Math.round((t - party.joinT) / 60000) : null,
          postedWaitMinutes: party && agent.targetPlaceId ? (() => { const w = predictedWaitAt(scene, agent.targetPlaceId!, t); return w === null ? null : Math.round(w / 60000); })() : null,
        });
        return out({
          agent, persona, group,
          observedFacts: scene.facts.get(persona.groupId)!.filter((f) => f.observedAtMs <= t),
          evidence: last ? buildAppliedDecision(scene, last.evidenceId, run.runId) : null,
          recentEvents: this.eventsUpTo(s, run, scene, t).filter((e) => e.agentIds.includes(i.agentId)).slice(-12),
          statusText, decisions: history,
        });
      }
      case 'getDecision': {
        const i = input as Queries['getDecision']['input'];
        const run = this.requireRun(s, identity, i.runId, 'viewer');
        const scene = this.scene(s, run);
        const d = scene.decisions.get(i.evidenceId);
        if (!d || d.atMs > this.timeline(run).committedSimMs) return fail('NOT_FOUND', 'Evidence not found.');
        return out(buildAppliedDecision(scene, i.evidenceId, run.runId));
      }
      case 'getEvents': {
        const i = input as Queries['getEvents']['input'];
        const run = this.requireRun(s, identity, i.runId, 'viewer');
        const scene = this.scene(s, run);
        const all = this.eventsUpTo(s, run, scene, this.timeline(run).committedSimMs).filter((e) => e.sequence > i.afterSequence);
        const limit = Math.max(1, Math.min(500, i.limit));
        const items = all.slice(0, limit);
        return out({ items, nextAfterSequence: all.length > limit ? items[items.length - 1]!.sequence : null });
      }
      case 'getMetrics': {
        const i = input as Queries['getMetrics']['input'];
        const run = this.requireRun(s, identity, i.runId, 'viewer');
        const scene = this.scene(s, run);
        const tl = this.timeline(run);
        const from = i.cursor ? Number(i.cursor) : Math.ceil(i.fromMs / 60_000) * 60_000;
        const to = Math.min(i.toMs, tl.committedSimMs);
        const items: MetricSnapshot[] = [];
        let t = from;
        for (; t <= to && items.length < 120; t += 60_000) items.push(metricsAt(scene, run.runId, t, this.revisionAt(run, t)));
        return out({ items, nextCursor: t <= to ? String(t) : null });
      }
      case 'getHeatmap': {
        const i = input as Queries['getHeatmap']['input'];
        const run = this.requireRun(s, identity, i.runId, 'viewer');
        const t = this.timeline(run).committedSimMs;
        return out(heatmapFor(this.scene(s, run), run.runId, i.layer, i.fromMs, Math.min(i.toMs, t), run.manifest.config.features.bumpReactions));
      }
      case 'getFrames': {
        const i = input as Queries['getFrames']['input'];
        const run = this.requireRun(s, identity, i.runId, 'viewer');
        // Same scrubbing density as Engine's compact frames: every 15 s (or denser if configured).
        const every = Math.min(run.manifest.config.visualFrameEveryMs, 15_000);
        const t = this.timeline(run).committedSimMs;
        const start = i.cursor ? Number(i.cursor) : Math.ceil(i.fromMs / every) * every;
        const end = Math.min(i.toMs, t);
        const items = [];
        let at = start;
        for (; at <= end && items.length < 10; at += every) items.push({ atMs: at, frameSchema: 'fixture-frame-v1', snapshot: this.snapshot(s, run, at) });
        return out({ items, nextCursor: at <= end ? String(at) : null });
      }
      case 'getExperiment': {
        const exp = s.experiments[(input as { experimentId: Id }).experimentId];
        if (!exp) return fail('NOT_FOUND', 'Experiment not found.');
        this.requireOperator(identity);
        return out(this.experimentReport(exp));
      }
      case 'getFactBundle': {
        const i = input as Queries['getFactBundle']['input'];
        if (i.runId) return out(this.factBundleForRun(s, this.requireRun(s, identity, i.runId, 'viewer')));
        const exp = s.experiments[i.experimentId ?? ''];
        if (!exp) return fail('NOT_FOUND', 'Experiment not found.');
        this.requireOperator(identity);
        return out(experimentFactBundle(this.experimentReport(exp), exp.experimentId));
      }
    }
    return fail('UNSUPPORTED', `Unknown query ${String(name)}.`);
  }

  getArtifactBytes(identity: string, ref: ArtifactRef): Uint8Array {
    const s = this.load();
    const a = s.artifacts[ref.artifactId];
    if (!a || a.ref.sha256 !== ref.sha256) return fail('NOT_FOUND', 'Artifact not found.');
    if (a.recipe.type === 'population' && !this.isOperator(identity)) fail('FORBIDDEN', 'Population artifacts are private to operators.');
    const body = a.recipe.type === 'park' ? canonicalJson(PARKS[a.recipe.stage]) : canonicalJson(this.population(a.recipe, this.parkRefSha(s, a.recipe.parkArtifactId)));
    return utf8(body);
  }
  private parkRefSha(s: State, id: Id) { return s.artifacts[id]!.ref.sha256; }

  // ------------------------------------------------------------ run timeline
  scene(s: State, run: RunRec): Scene {
    const cached = sceneCache.get(run.runId + run.manifestHash);
    if (cached) return cached;
    const popRec = s.artifacts[run.manifest.population.artifactId]!.recipe as Extract<Recipe, { type: 'population' }>;
    const population = this.population(popRec, this.parkRefSha(s, popRec.parkArtifactId));
    const park = this.parkFromRef(s, run.manifest.park);
    const scene = generateScene({
      park, population, seed: run.manifest.replicateSeed, horizonMs: run.manifest.config.horizonMs,
      passPriceSchedule: run.manifest.scenario.events.flatMap((e) => (e.change.kind === 'pass_price' ? [{ atMs: e.atMs, cents: e.change.unitPriceCents }] : [])),
      ratingEveryMs: run.manifest.config.ratingEveryMs, earlyDepartureThresholdMs: run.manifest.config.earlyDepartureThresholdMs, runId: run.runId,
    });
    sceneCache.set(run.runId + run.manifestHash, scene);
    return scene;
  }

  timeline(run: RunRec, at = this.now()) {
    const horizon = run.manifest.config.horizonMs;
    let status: RunView['status'] = at < run.readyAt ? 'preparing' : 'ready';
    let exact = 0; let speed = run.manifest.config.requestedSpeed; let blocked = false; let barrierDone = false; let barrierAge = 0;
    if (run.control.length) {
      const last = run.control[run.control.length - 1]!;
      speed = last.speed;
      const paused = run.control.reduce<boolean>((p, c) => (c.kind === 'pause' ? true : c.kind === 'resume' || c.kind === 'start' ? false : p), false);
      if (last.kind === 'cancel') { status = 'cancelled'; exact = last.simMs; }
      else if (paused) { status = 'paused'; exact = last.simMs; }
      else {
        status = 'running';
        const dt = at - last.epoch;
        exact = last.simMs + dt * last.speed;
        if (last.simMs <= BARRIER_SIM_MS && horizon > BARRIER_SIM_MS) {
          const reach = last.epoch + (BARRIER_SIM_MS - last.simMs) / last.speed;
          if (at >= reach && at < reach + BARRIER_WALL_MS) { exact = BARRIER_SIM_MS; blocked = true; barrierAge = at - reach; status = 'blocked'; }
          else if (at >= reach + BARRIER_WALL_MS) { exact = BARRIER_SIM_MS + (at - reach - BARRIER_WALL_MS) * last.speed; barrierDone = true; }
        } else if (last.simMs > BARRIER_SIM_MS) barrierDone = true;
        if (exact >= horizon) { exact = horizon; status = 'completed'; }
      }
      if (status === 'paused' && last.simMs > BARRIER_SIM_MS) barrierDone = true;
    }
    const committed = Math.floor(exact / STEP_MS) * STEP_MS;
    const stepIndex = committed / STEP_MS;
    return { status, exactSimMs: exact, committedSimMs: committed, stepIndex, speed, blocked, barrierAge,
      revision: stepIndex + run.controlRevision + run.scenarioRevision + (at >= run.readyAt ? 1 : 0) + (barrierDone ? 1 : 0) + (status === 'completed' ? 1 : 0) };
  }
  private revisionAt(run: RunRec, simMs: number) { return simMs / STEP_MS + run.controlRevision + run.scenarioRevision; }

  runView(s: State, run: RunRec, at = this.now()): RunView {
    const tl = this.timeline(run, at);
    const scene = tl.status === 'preparing' ? null : this.scene(s, run);
    return {
      runId: run.runId, revision: tl.revision, controlRevision: run.controlRevision, manifestHash: run.manifestHash, mode: run.manifest.config.mode,
      status: tl.status, simMs: tl.committedSimMs, stepIndex: tl.stepIndex, phase: tl.blocked ? 'barrier' : 'persist',
      scenarioRevision: String(run.scenarioRevision), earliestSchedulableMs: tl.committedSimMs + STEP_MS,
      requestedSpeed: tl.speed, achievedSpeed: tl.status === 'running' ? tl.speed : 0,
      blockedWorkIds: tl.blocked ? ['fixture-work:decision:g017:barrier'] : [],
      quality: scene ? this.quality(scene, tl.committedSimMs) : emptyQuality(),
    };
  }
  private quality(scene: Scene, t: number): Quality {
    let mock = 0;
    for (const d of scene.decisions.values()) if (d.atMs <= t) mock++;
    let pending = 0; let expected = 0; let complete = 0;
    for (const list of scene.ratings.values()) for (const r of list) {
      if (r.atMs <= t && r.availableAtMs > t) pending++;
      if (r.endpoint !== 'periodic' && r.atMs <= t) { expected++; if (r.index !== null && r.availableAtMs <= t) complete++; }
    }
    return { comparisonEligible: false, reasons: ['Fixture run: scripted data is never comparison-eligible.'], behaviorCounts: { jev: 0, cache: 0, mock, fallback: 0 },
      invalidAttempts: 0, staleAttempts: 0, pendingRatings: pending, terminalRatingsExpected: expected, terminalRatingsComplete: complete };
  }

  private appliedScenario(run: RunRec, t: number) {
    return run.scheduled.filter((e) => e.atMs <= t).sort((a, b) => a.atMs - b.atMs || a.order - b.order);
  }

  eventsUpTo(s: State, run: RunRec, scene: Scene, t: number): EventRecord[] {
    const base = scene.events.filter((e) => e.atMs <= t);
    const extra: EventRecord[] = this.appliedScenario(run, t).map((e, i) => {
      const before = scene.events.filter((x) => x.atMs <= e.atMs);
      const seq = (before.length ? before[before.length - 1]!.sequence : 0) + 1 + (i % 9);
      return { eventId: `evt:${run.runId}:scenario:${e.id}`, runId: run.runId, sequence: seq, atMs: e.atMs, kind: 'scenario_applied',
        groupId: null, agentIds: [], placeId: 'placeId' in e.change ? (e.change as { placeId: Id }).placeId : null, position: null,
        causationId: e.id, amountCents: null, experienceDelta: null, reason: `${e.change.kind} applied (fixture: scripted guests do not react)`,
        details: { scenarioEventId: e.id, change: e.change as unknown as import('../../contract/behavior-v1').Json } };
    });
    return [...base, ...extra].sort((a, b) => a.sequence - b.sequence);
  }

  placeViews(s: State, run: RunRec, scene: Scene, t: number): PlaceView[] {
    const applied = this.appliedScenario(run, t);
    return scene.park.places.map((p) => {
      const mine = applied.filter((e) => 'placeId' in e.change && (e.change as { placeId: Id }).placeId === p.id);
      const closure = [...mine].reverse().find((e) => e.change.kind === 'closure');
      const boards = mine.filter((e) => e.change.kind === 'board');
      const notices = mine.filter((e) => e.change.kind === 'notice');
      const predicted = predictedWaitAt(scene, p.id, t);
      const display: WaitDisplay | null = boards.length ? (boards[boards.length - 1]!.change as { display: WaitDisplay }).display : p.board;
      return {
        placeId: p.id, closed: closure ? (closure.change as { closed: boolean }).closed : false,
        boardText: display ? formatBoard(display, predicted) : null,
        boardVersion: boards.length ? `board:${p.id}:${boards[boards.length - 1]!.id}` : `board:${p.id}:runtime`,
        noticeVersion: `notice:${p.id}:v${1 + notices.length}`, predictedWaitMs: predicted,
      };
    });
  }

  snapshot(s: State, run: RunRec, atSimMs?: number): LiveSnapshot {
    const tl = this.timeline(run);
    const t = atSimMs ?? tl.committedSimMs;
    const view = this.runView(s, run);
    if (tl.status === 'preparing') {
      return { contractVersion: CONTRACT_VERSION, run: view, agents: [], places: [], queues: [], metrics: emptyMetrics(run.runId, view.revision), health: health(false, 0), recentEvents: [] };
    }
    const scene = this.scene(s, run);
    const agents = scene.population.personas.map((p) => agentViewAt(scene, p.agentId, t)).filter((a): a is NonNullable<typeof a> => a !== null);
    const runAt = atSimMs === undefined ? view : { ...view, simMs: t, stepIndex: t / STEP_MS, revision: this.revisionAt(run, t) };
    return {
      contractVersion: CONTRACT_VERSION, run: runAt, agents, places: this.placeViews(s, run, scene, t), queues: queueViewsAt(scene, t),
      metrics: metricsAt(scene, run.runId, t, runAt.revision), health: health(tl.blocked && atSimMs === undefined, tl.barrierAge),
      recentEvents: this.eventsUpTo(s, run, scene, t).slice(-60),
    };
  }

  factBundleForRun(s: State, run: RunRec) {
    const scene = this.scene(s, run);
    const t = this.timeline(run).committedSimMs;
    return runFactBundle(scene, run.runId, metricsAt(scene, run.runId, t, this.revisionAt(run, t)), this.quality(scene, t));
  }

  scenarioContext(s: State, runId: Id | null, parkRef: ArtifactRef) {
    const park = this.parkFromRef(s, parkRef);
    const run = runId ? s.runs[runId] : null;
    const view = run ? this.runView(s, run) : null;
    const summary: ParkSummary = { parkId: park.parkId, revision: park.revision, label: park.label, artifact: parkRef, status: 'ready', issues: [] };
    return { runId, currentSimMs: view?.simMs ?? 0, earliestSchedulableMs: view?.earliestSchedulableMs ?? 0, scenarioRevision: run ? String(run.scenarioRevision) : '1',
      park: summary, places: park.places.map((p) => ({ id: p.id, name: p.name, kind: p.kind })), capabilities: FIXTURE_CAPABILITIES };
  }

  private experimentReport(exp: ExpRec): ExperimentReport {
    const elapsed = this.now() - exp.createdAt;
    const s = this.load();
    const parkStage = (s.artifacts[exp.spec.park.artifactId]?.recipe as { stage?: 1 | 2 } | undefined)?.stage ?? 1;
    const park = PARKS[parkStage];
    const pairs = exp.spec.seeds.map((seed, i) => {
      const doneAt = 1500 + i * 1500;
      const crowd: CrowdSpec = { ...exp.spec.crowd, seed };
      const pop = buildFixturePopulation(crowd, park, exp.spec.park.sha256).manifest;
      const mk = (sc: Scenario) => generateScene({ park, population: pop, seed, horizonMs: exp.spec.config.horizonMs,
        passPriceSchedule: sc.events.flatMap((e) => (e.change.kind === 'pass_price' ? [{ atMs: e.atMs, cents: e.change.unitPriceCents }] : [])),
        ratingEveryMs: exp.spec.config.ratingEveryMs, earlyDepartureThresholdMs: exp.spec.config.earlyDepartureThresholdMs, runId: `${exp.experimentId}:${seed}` });
      if (elapsed < doneAt) return { seed, a: null, b: null, status: (elapsed > doneAt - 1500 ? 'running' : 'pending') as 'running' | 'pending', reasons: [] };
      const key = `${exp.experimentId}:${seed}`;
      let a = sceneCache.get(key + ':A'); if (!a) { a = mk(exp.spec.baseline); sceneCache.set(key + ':A', a); }
      // Fixture demonstration of an incomplete pair: the last of 3+ seeds stops arm B early.
      const incomplete = exp.spec.seeds.length >= 3 && i === exp.spec.seeds.length - 1;
      let b = sceneCache.get(key + ':B'); if (!b) { b = mk(exp.spec.variant); sceneCache.set(key + ':B', b); }
      return incomplete
        ? { seed, a, b: null, status: 'incomplete' as const, reasons: ['Fixture demonstration: arm B scripted to stop before the horizon; excluded from summaries.'] }
        : { seed, a, b, status: 'complete' as const, reasons: [] };
    });
    return experimentReport(exp.spec, pairs, Math.min(10, 1 + Math.floor(elapsed / 1500)), (seed, arm) => `${exp.experimentId}-${seed}-${arm}`);
  }
}

function formatBoard(d: WaitDisplay, predicted: number | null): string {
  if (d.kind === 'fixed') return d.text;
  if (predicted === null) return 'Wait unavailable';
  const min = Math.max(d.roundToMin, Math.round(predicted / 60_000 / d.roundToMin) * d.roundToMin);
  if (d.kind === 'rounded_estimate') return d.template.replace('{minutes}', String(min));
  const lo = Math.max(0, min - Math.floor(d.spreadMin / 2));
  return d.template.replace('{lower}', String(lo)).replace('{upper}', String(lo + d.spreadMin));
}
function emptyQuality(): Quality {
  return { comparisonEligible: false, reasons: ['Run is preparing.'], behaviorCounts: { jev: 0, cache: 0, mock: 0, fallback: 0 }, invalidAttempts: 0, staleAttempts: 0, pendingRatings: 0, terminalRatingsExpected: 0, terminalRatingsComplete: 0 };
}
function emptyMetrics(runId: Id, revision: number): MetricSnapshot {
  const ids = ['net_revenue_cents', 'revenue_per_guest_cents', 'satisfaction_0_100', 'queue_minutes_per_guest', 'completed_ride_wait_minutes', 'rides_per_guest', 'abandonment_rate', 'queue_time_share', 'early_departures', 'ride_seat_utilization', 'server_utilization'] as const;
  const unit = { net_revenue_cents: 'cents', revenue_per_guest_cents: 'cents', satisfaction_0_100: 'score', queue_minutes_per_guest: 'minutes', completed_ride_wait_minutes: 'minutes', rides_per_guest: 'ratio', abandonment_rate: 'ratio', queue_time_share: 'ratio', early_departures: 'guests', ride_seat_utilization: 'ratio', server_utilization: 'ratio' } as const;
  return { runId, simMs: 0, revision, definitionVersion: 'metrics-v1', admittedGuests: 0, guestsInPark: 0,
    measures: Object.fromEntries(ids.map((id) => [id, { id, value: null, unit: unit[id], numerator: 0, denominator: 0, n: 0, coverage: 0, complete: false, missingReason: 'run not started' }])) as MetricSnapshot['measures'] };
}
function health(blocked: boolean, age: number): Health {
  return { queuedWork: blocked ? 1 : 0, leasedWork: blocked ? 1 : 0, oldestRequestAgeMs: blocked ? age : 0, httpP95Ms: null, reducerP95Ms: null,
    calls: 0, inputTokens: 0, estimatedCostUsd: 0, tokenCoverage: 1, warnings: blocked ? ['Fixture: scripted inference barrier (simulation clock waits; guests do not "take longer").'] : [] };
}
