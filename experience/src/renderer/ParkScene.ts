/**
 * PixiJS isometric scene for the live park. Canvas animation runs on Pixi's ticker,
 * separate from React; React only pushes authoritative samples and settings in.
 *
 * Layers (all in iso plane units, one camera transform):
 *   slab -> baked ground texture -> back walls + queue stanchions -> ground decals/rings
 *   -> depth-sorted objects (structures, trees, guests) -> front walls + gate -> markers.
 * Guests are pooled sprites from one atlas (single batch); depth is x + y with a per-frame
 * correction against the few structures whose screen box a guest overlaps.
 */
import { Application, CanvasSource, Container, Graphics, Matrix, Sprite, Texture } from 'pixi.js';
import type { AgentView, Id, QueueZone, Vec2 } from '../../contract/behavior-v1';
import { ATLAS_RES, buildAtlas, POSES, PERSON_VARIANTS, type Atlas, type Pose } from './atlas';
import { IsoCamera, type ScreenPt } from './camera';
import { experienceColor, satisfactionColor, STALE_RATING_MS, STATE_STYLE, UNRATED_COLOR, type ColorMode, type Shape } from './colors';
import type { Walkable } from './interpolation';
import { AdaptiveClock, dampOffset, MotionHistory } from './smoothing';
import { IsoProjection, SLAB_M } from './iso';
import { BUILD, hashStr, shade } from './palette';
import { buildGate, buildStructure, Iso3D, type Structure, type StructurePlace } from './structures';
import { cellMaterials, paintLightPools, paintTerrain, placeLamps, placeTrees, queueRails, type DecorCell, type TreeSpot } from './terrain';
import { lightingAt, parseOpenLocal, tintNum, type Lighting } from './lighting';

export type SceneInit = {
  host: HTMLElement;
  codes: Uint8Array;
  grid: { width: number; height: number; cellM: number; grassWalkable: boolean };
  places: { id: Id; kind: string; entrance: Vec2 }[];
  queueZones: QueueZone[];
  decor: DecorCell[];
  structures: StructurePlace[];
  gate: { x0: number; x1: number; y: number } | null;
  walkable: Walkable;
  /** Park opening local time "HH:MM"; with the render clock this drives day/night lighting. */
  openLocal?: string;
  onPick: (agentId: Id | null) => void;
  onHover?: (agentId: Id | null) => void;
  onFollowChange?: (following: boolean) => void;
  onFailure: (message: string) => void;
  onCameraChange: () => void;
  /** Static still (previews): no input, no ticker; render on demand with `renderStill`. */
  staticView?: boolean;
};

/** Minimum on-screen figure height so crowds stay legible when zoomed out. */
const MIN_FIGURE_PX = 9.5;
const WALK_CYCLE: Pose[] = ['walkA', 'stand', 'walkB', 'stand'];
const MOVING_STATES = new Set<AgentView['state']>(['walking', 'browsing', 'deciding']);
const INSIDE_STATES = new Set<AgentView['state']>(['riding', 'watching']);

type Guest = {
  c: Container; person: Sprite; cloth: Sprite; decal: Sprite;
  variant: number; height: number; phase: number; face: 1 | -1; faceAcc: number; lastX: number; lastY: number;
  /** Display correction offset (metres) decayed by a critically damped spring. */
  off: { x: number; y: number; vx: number; vy: number };
  /** Plane-space feet position and on-screen scale factor, refreshed every frame. */
  px: number; py: number; k: number; z: number;
};

/** Forward jumps larger than any live burst or recorded-frame gap are treated as seeks. */
const SEEK_JUMP_MS = 180_000;

export class ParkScene {
  readonly camera: IsoCamera;
  readonly proj: IsoProjection;
  private app!: Application;
  private atlas!: Atlas;
  private world = new Container();
  private decals = new Container();
  private objects = new Container();
  private groundFx = new Graphics();
  private topFx = new Graphics();
  private guests = new Map<Id, Guest>();
  private tracks = new Map<Id, MotionHistory>();
  private views = new Map<Id, AgentView>();
  private display = new Map<Id, Vec2>();
  private clock = new AdaptiveClock();
  private renderSim = 0;
  private lastFrame = 0;
  private colorMode: ColorMode = 'state';
  private nowSimMs = 0;
  private selected: Id | null = null;
  private hovered: Id | null = null;
  private groupIds: Id[] = [];
  private follow = false;
  private epoch = -1;
  private destroyed = false;
  private cleanup: (() => void)[] = [];
  private lastAgents: ReadonlyMap<Id, AgentView> | null = null;
  private structures: Structure[] = [];
  private structureAt!: Int16Array;
  private buckets = new Map<number, number[]>();
  private sBounds: { x0: number; y0: number; x1: number; y1: number }[] = [];
  private anchors = new Map<Id, { p: Vec2; z: number }>();
  private placeEntrance = new Map<Id, Vec2>();
  private releasables: HTMLCanvasElement[] = [];
  // Day/night lighting.
  private litLayers: (Sprite | Graphics)[] = [];
  private shadowLayer!: Sprite;
  private poolLayer!: Sprite;
  private glowLayers: Graphics[] = [];
  private lampGlows: Sprite[] = [];
  private beams: { g: Graphics; at: [number, number, number] }[] = [];
  private haze!: Sprite;
  private openHour = 9;
  private hourOverride: number | null = null;
  private light: Lighting = lightingAt(9);
  private lightKey = -1;
  private guestTint = 0xffffff;

  private constructor(private readonly init: SceneInit) {
    this.openHour = parseOpenLocal(init.openLocal);
    for (const p of init.places) this.placeEntrance.set(p.id, p.entrance);
    this.proj = new IsoProjection(init.grid.width * init.grid.cellM, init.grid.height * init.grid.cellM);
    this.camera = new IsoCamera(this.proj);
  }

  static async create(init: SceneInit): Promise<ParkScene> {
    const scene = new ParkScene(init);
    await scene.start();
    return scene;
  }

  private async start() {
    const { host } = this.init;
    const app = new Application();
    await app.init({
      width: Math.max(1, host.clientWidth), height: Math.max(1, host.clientHeight), antialias: true, autoDensity: true,
      resolution: Math.min(2.5, window.devicePixelRatio || 1), background: '#b8dcf0', preference: 'webgl',
      autoStart: !this.init.staticView, sharedTicker: false,
    });
    if (this.destroyed) { app.destroy(true); return; }
    this.app = app;
    const canvas = app.canvas;
    canvas.setAttribute('aria-hidden', 'true'); // the accessible alternative is the guest list
    canvas.tabIndex = -1;
    host.appendChild(canvas);

    this.buildWorld(softwareRenderer(app));
    {
      const W = this.init.grid.width * this.init.grid.cellM; const H = this.init.grid.height * this.init.grid.cellM; const p = this.proj;
      let top = p.py(0, 0, 1.6);
      for (const st of this.structures) top = Math.min(top, p.py((st.foot.x0 + st.foot.x1) / 2, (st.foot.y0 + st.foot.y1) / 2, st.topM));
      this.camera.content = { x0: -1, y0: top - 1, x1: p.planeW + 1, y1: p.py(W, H, -SLAB_M) + 1 };
    }
    app.stage.addChild(this.world, this.haze);

    this.camera.setViewport(host.clientWidth, host.clientHeight);
    this.camera.fit();
    if (this.init.staticView) return;
    this.attachInput(canvas);
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(host);
    this.cleanup.push(() => ro.disconnect());
    const lost = (e: Event) => { e.preventDefault(); this.init.onFailure('The map graphics context was lost (GPU reset or memory pressure). Guest list and statistics still work.'); };
    canvas.addEventListener('webglcontextlost', lost);
    this.cleanup.push(() => canvas.removeEventListener('webglcontextlost', lost));
    const vis = () => { if (document.visibilityState === 'visible') this.clock.snapToTarget(performance.now()); };
    document.addEventListener('visibilitychange', vis);
    this.cleanup.push(() => document.removeEventListener('visibilitychange', vis));
    app.ticker.add(() => this.frame());
  }

  private buildWorld(lowPower: boolean) {
    const { grid, codes } = this.init;
    const W = grid.width; const H = grid.height;
    const proj = this.proj;
    this.atlas = buildAtlas();

    // Structures first: their cast shadows are baked into the ground.
    const blockedFootprint = (s: StructurePlace) => {
      for (let y = s.footprint.y; y < s.footprint.y + s.footprint.h; y++) for (let x = s.footprint.x; x < s.footprint.x + s.footprint.w; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H || codes[y * W + x] !== 0) return false;
      }
      return true;
    };
    this.structures = this.init.structures.filter(blockedFootprint).map((s) => buildStructure(proj, s));
    if (this.init.gate) this.structures.push(buildGate(proj, this.init.gate.x0, this.init.gate.x1, this.init.gate.y));
    this.structureAt = new Int16Array(W * H).fill(-1);
    this.structures.forEach((s, i) => {
      if (s.id === 'gate') return;
      for (let y = Math.floor(s.foot.y0); y < s.foot.y1; y++) for (let x = Math.floor(s.foot.x0); x < s.foot.x1; x++) if (x >= 0 && y >= 0 && x < W && y < H) this.structureAt[y * W + x] = i;
      this.anchors.set(s.id, { p: { xM: (s.foot.x0 + s.foot.x1) / 2, yM: (s.foot.y0 + s.foot.y1) / 2 }, z: Math.min(s.topM, 13) + 1.5 });
    });

    const queueOrder = this.init.queueZones.map((q) => q.cellIndices);
    // Provisional materials for tree placement (same rules as the painter).
    // Ground texels per metre; software rasterisers (CI, VMs) get a lighter tier.
    const P = Math.max(4, Math.min(lowPower ? 5 : 10, Math.floor(4096 / Math.max(W, H))));
    const shadows = this.structures.flatMap((s) => s.shadows);
    const pre = cellMaterials(codes, W, H, this.init.decor);
    const trees: TreeSpot[] = placeTrees(codes, W, H, grid.grassWalkable, pre);
    const { canvas, shadow, shadowPxPerM: SP } = paintTerrain({ codes, width: W, height: H, grassWalkable: grid.grassWalkable, decor: this.init.decor, queueOrder, shadows, trees, pxPerM: P });
    const lamps = placeLamps(codes, W, H, pre, (i) => this.structureAt[i]! >= 0);
    const pools = paintLightPools(W, H, SP, lamps, this.structures.flatMap((st) => st.spills));
    this.releasables.push(canvas, shadow, pools, this.atlas.source.resource as HTMLCanvasElement);
    const layerTex = (c: HTMLCanvasElement) => new Texture({ source: new CanvasSource({ resource: c, autoGenerateMipmaps: false, scaleMode: 'linear' }) });
    this.shadowLayer = new Sprite(layerTex(shadow));
    this.shadowLayer.setFromMatrix(new Matrix(...proj.groundMatrix(SP / grid.cellM)));
    this.poolLayer = new Sprite(layerTex(pools));
    this.poolLayer.setFromMatrix(new Matrix(...proj.groundMatrix(SP / grid.cellM)));
    this.poolLayer.blendMode = 'add';
    const groundTex = new Texture({ source: new CanvasSource({ resource: canvas, autoGenerateMipmaps: !lowPower, scaleMode: 'linear', maxAnisotropy: lowPower ? 1 : 8 }) });
    const ground = new Sprite(groundTex);
    ground.setFromMatrix(new Matrix(...proj.groundMatrix(P / grid.cellM)));

    // Model base slab under the two visible park edges.
    const slab = new Graphics(); const sd = new Iso3D(slab, proj);
    sd.poly([[0, H, 0], [W, H, 0], [W, H, -SLAB_M], [0, H, -SLAB_M]], 0x3a3129);
    sd.poly([[W, H, 0], [W, 0, 0], [W, 0, -SLAB_M], [W, H, -SLAB_M]], 0x2a241f);
    for (const z of [-1.1, -2.3]) sd.line([[0, H, z], [W, H, z], [W, 0, z]], 0x000000, 0.08, 0.25);
    sd.line([[0, H, 0], [W, H, 0], [W, 0, 0]], 0x8f8574, 0.15, 0.6);

    // Boundary walls: back (north/west) under everything, front (south/east) over everything.
    const back = new Graphics(); const bd = new Iso3D(back, proj);
    const wallH = 1.1;
    bd.box(0, 0, W, 0.7, 0, wallH, BUILD.stoneDark, shade(BUILD.stone, 0.95), { shadow: false });
    bd.box(0, 0, 0.7, H, 0, wallH, BUILD.stoneDark, shade(BUILD.stone, 0.95), { shadow: false });
    this.drawStanchions(bd, queueOrder, W);
    const frontWalls = new Graphics(); const fd = new Iso3D(frontWalls, proj);
    const front = new Container(); front.addChild(frontWalls);
    fd.box(W - 0.7, 0, W, H, 0, wallH, BUILD.stoneDark, shade(BUILD.stone, 0.95), { shadow: false });
    fd.box(0, H - 0.7, W, H, 0, wallH, BUILD.stoneDark, shade(BUILD.stone, 0.95), { shadow: false });
    for (let x = 4; x < W; x += 8) fd.box(x - 0.45, H - 0.85, x + 0.45, H + 0.05, 0, wallH + 0.5, BUILD.stone, shade(BUILD.stone, 1.1), { shadow: false, edge: false });
    for (let y = 4; y < H; y += 8) fd.box(W - 0.85, y - 0.45, W + 0.05, y + 0.45, 0, wallH + 0.5, BUILD.stone, shade(BUILD.stone, 1.1), { shadow: false, edge: false });

    // Depth-sorted objects.
    this.objects.sortableChildren = true;
    const gateIdx = this.structures.findIndex((s) => s.id === 'gate');
    this.structures.forEach((s, i) => {
      s.g.zIndex = s.depth;
      if (i === gateIdx) front.addChild(s.g); else this.objects.addChild(s.g);
    });
    // Plane-space bounds of structures + a bucket grid for per-guest occlusion tests.
    this.sBounds = this.structures.map((s) => { const b = s.g.getLocalBounds(); return { x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY }; });
    this.sBounds.forEach((b, i) => {
      if (i === gateIdx) return;
      for (let by = Math.floor(b.y0 / 16); by <= Math.floor(b.y1 / 16); by++) for (let bx = Math.floor(b.x0 / 16); bx <= Math.floor(b.x1 / 16); bx++) {
        const key = by * 4096 + bx; const list = this.buckets.get(key) ?? []; list.push(i); this.buckets.set(key, list);
      }
    });
    for (const t of trees) {
      const f = this.atlas.tree[t.kind];
      const s = new Sprite(f.tex);
      s.anchor.set(f.ax, f.ay);
      s.scale.set(t.scale / ATLAS_RES);
      s.position.set(proj.px(t.x, t.y), proj.py(t.x, t.y));
      s.zIndex = this.depthFor(t.x, t.y, s.position.x, s.position.y, 2.5 * t.scale, 9 * t.scale);
      this.objects.addChild(s);
    }
    // Lamp posts (depth-sorted props) and their additive heads.
    const lf = this.atlas.lamp; const gf = this.atlas.glow;
    for (const l of lamps) {
      // Post + additive head in one depth-sorted container so buildings in front occlude it.
      const c = new Container();
      const sp = new Sprite(lf.tex); sp.anchor.set(lf.ax, lf.ay); sp.scale.set(1 / ATLAS_RES);
      c.addChild(sp); this.litLayers.push(sp);
      for (const [r, a, tint] of [[3.4, 0.45, 0xffb868], [0.8, 1, 0xfff0d0]] as const) {
        const h = new Sprite(gf.tex); h.anchor.set(0.5); h.tint = tint; h.alpha = a; h.blendMode = 'add';
        h.scale.set(r / 32); h.position.set(0, -this.atlas.lampHeadH);
        c.addChild(h); this.lampGlows.push(h);
      }
      const lx = proj.px(l.x, l.y); const ly = proj.py(l.x, l.y);
      c.position.set(lx, ly);
      c.zIndex = this.depthFor(l.x, l.y, lx, ly, 0.3, 5);
      this.objects.addChild(c);
    }
    for (const st of this.structures) {
      this.litLayers.push(st.body); this.glowLayers.push(st.glow);
      if (st.beacon) {
        const bg = new Graphics(); bg.blendMode = 'add';
        this.beams.push({ g: bg, at: st.beacon });
      }
    }
    this.litLayers.push(ground, slab, back, frontWalls);
    for (const c of this.objects.children) if (c instanceof Sprite && !this.litLayers.includes(c)) this.litLayers.push(c); // trees
    this.world.addChild(slab, ground, this.shadowLayer, this.poolLayer, back, this.groundFx, this.decals, this.objects, front, ...this.beams.map((b) => b.g), this.topFx);
    // Screen-space atmospheric haze from the upper left.
    const hz = document.createElement('canvas'); hz.width = 128; hz.height = 128;
    const hctx = hz.getContext('2d')!;
    const hg = hctx.createRadialGradient(0, 0, 0, 0, 0, 128);
    hg.addColorStop(0, 'rgba(255,255,255,1)'); hg.addColorStop(0.55, 'rgba(255,255,255,0.35)'); hg.addColorStop(1, 'rgba(255,255,255,0)');
    hctx.fillStyle = hg; hctx.fillRect(0, 0, 128, 128);
    this.haze = new Sprite(layerTex(hz)); this.haze.blendMode = 'add';
    this.releasables.push(hz);
  }

  private drawStanchions(d: Iso3D, order: number[][], W: number) {
    const rails = queueRails(order, W);
    const ropeZ = 0.95;
    const posts = new Set<string>();
    for (const [ax, ay, bx, by] of rails) {
      d.line([[ax, ay, ropeZ], [bx, by, ropeZ]], 0x7a2f2a, 0.07, 0.95);
      for (const [x, y] of [[ax, ay], [bx, by]] as const) posts.add(`${x},${y}`);
    }
    for (const key of posts) {
      const [x, y] = key.split(',').map(Number) as [number, number];
      d.line([[x, y, 0], [x, y, ropeZ + 0.08]], 0x2c2a28, 0.09, 1);
      d.line([[x, y, ropeZ + 0.06], [x, y, ropeZ + 0.12]], 0xb0a58a, 0.12, 1);
    }
  }

  /** Painter's depth for a point object at ground (x, y) with plane position and extent. */
  private depthFor(x: number, y: number, px: number, py: number, halfW: number, height: number): number {
    let z = x + y;
    let lo = Infinity; let hi = -Infinity;
    const seen = new Set<number>();
    for (let by = Math.floor((py - height) / 16); by <= Math.floor(py / 16); by++) for (let bx = Math.floor((px - halfW) / 16); bx <= Math.floor((px + halfW) / 16); bx++) {
      const list = this.buckets.get(by * 4096 + bx);
      if (!list) continue;
      for (const i of list) {
        if (seen.has(i)) continue; seen.add(i);
        const b = this.sBounds[i]!;
        if (px + halfW < b.x0 || px - halfW > b.x1 || py < b.y0 || py - height > b.y1) continue;
        const s = this.structures[i]!;
        if (x >= s.foot.x1 || y >= s.foot.y1) hi = Math.max(hi, s.depth + 0.01); else lo = Math.min(lo, s.depth - 0.01);
      }
    }
    if (hi > -Infinity) z = Math.max(z, hi);
    if (lo < Infinity) z = Math.min(z, lo);
    return z;
  }

  resize() {
    if (!this.app || this.destroyed) return;
    const { clientWidth: w, clientHeight: h } = this.init.host;
    this.app.renderer.resize(Math.max(1, w), Math.max(1, h));
    this.camera.setViewport(w, h);
    this.init.onCameraChange();
  }

  /** Push authoritative agents at the committed sim time. Identity-unchanged agents are skipped. */
  setAgents(agents: ReadonlyMap<Id, AgentView>, simMs: number, epoch: number) {
    // Time going backwards, or leaping far ahead, is a seek (timeline scrub, source switch
    // between the live stream and recorded frames whose epoch counters are independent).
    const seek = this.lastAgents !== null && (simMs < this.nowSimMs || simMs - this.nowSimMs > SEEK_JUMP_MS);
    if (epoch !== this.epoch || seek) {
      // New snapshot / seek / run switch: no interpolation from previous content.
      this.tracks.clear();
      for (const g of this.guests.values()) { g.off.x = g.off.y = g.off.vx = g.off.vy = 0; g.lastX = g.lastY = NaN; }
      this.epoch = epoch;
      this.lastAgents = null;
      this.clock.reset(simMs, performance.now());
    }
    // Live patches can deliver agent changes before the run clock advances. Stamping them with
    // the old sim time would overwrite the previous sample and make whole groups hop, so while
    // running, hold them until the committed time moves on (the store map then holds them all).
    if (this.lastAgents && simMs <= this.nowSimMs && this.clock.isRunning) return;
    const prevAgents = this.lastAgents;
    const walkable = this.init.walkable;
    const ex = this.clock.extrapolation;
    const budget = { nodes: 60_000 }; // grid-routing work per batch (~a few ms)
    for (const [id, a] of agents) {
      let h = this.tracks.get(id);
      if (h && prevAgents && prevAgents.get(id) === a) {
        // Unchanged authoritative pose: it was stationary through this committed time.
        if (h.latest.simMs < simMs) h.push({ ...h.latest, simMs }, walkable, budget);
        continue;
      }
      if (!h) { h = new MotionHistory(); this.tracks.set(id, h); }
      const g = this.guests.get(id);
      const before = g && h.s.length ? h.at(this.renderSim, ex, walkable).pos : null;
      h.push({ simMs, pos: a.position, state: a.state }, walkable, budget);
      if (g && before) {
        // Keep the display continuous: the change in the target at the current render time
        // (e.g. extrapolation meeting the real sample) becomes a spring-damped offset.
        const after = h.at(this.renderSim, ex, walkable).pos;
        const dx = before.xM - after.xM + g.off.x; const dy = before.yM - after.yM + g.off.y;
        if (Math.hypot(dx, dy) < 4) { g.off.x = dx; g.off.y = dy; } else { g.off.x = g.off.y = g.off.vx = g.off.vy = 0; }
      }
      this.views.set(id, a);
    }
    for (const id of [...this.tracks.keys()]) if (!agents.has(id)) this.tracks.delete(id);
    for (const id of [...this.views.keys()]) if (!agents.has(id)) { this.views.delete(id); this.display.delete(id); }
    for (const [id, g] of [...this.guests]) {
      if (!agents.has(id)) { g.c.destroy({ children: true }); g.decal.destroy(); this.guests.delete(id); }
    }
    this.lastAgents = agents;
    this.nowSimMs = simMs;
  }

  setRunClock(targetSimMs: number, speed: number, running: boolean) {
    this.clock.update(targetSimMs, speed, running, performance.now());
  }

  /** Seek / discrete jump (replay): rebuild the scene from the new frame without tweening. */
  hardReset(simMs: number) {
    this.epoch = -1;
    this.clock.reset(simMs, performance.now());
    this.clock.snapToTarget(performance.now());
  }

  setColorMode(mode: ColorMode) { this.colorMode = mode; }
  setSelection(agentId: Id | null, groupIds: Id[]) {
    if (agentId !== this.selected && this.follow && !agentId) this.setFollow(false);
    this.selected = agentId; this.groupIds = groupIds;
  }
  setFollow(on: boolean) {
    if (this.follow === on) return;
    this.follow = on;
    this.init.onFollowChange?.(on);
  }
  get following() { return this.follow; }
  getDisplayPositions(): ReadonlyMap<Id, Vec2> { return this.display; }

  zoomBy(factor: number) {
    const sel = this.follow && this.selected ? this.guests.get(this.selected) : null;
    const at = sel ? this.camera.planeToScreen(sel.px, sel.py) : { x: this.camera.viewW / 2, y: this.camera.viewH / 2 };
    this.camera.zoomAt(at, factor); this.init.onCameraChange();
  }
  panBy(dx: number, dy: number) { this.setFollow(false); this.camera.pan(dx, dy); this.init.onCameraChange(); }
  fit() { this.setFollow(false); this.camera.fit(); this.init.onCameraChange(); }
  centerOn(p: Vec2) { this.camera.centerOn(p); this.init.onCameraChange(); }

  /** Screen position (CSS px, relative to host) of an agent's body as currently displayed. */
  agentScreenPosition(id: Id): ScreenPt | null {
    const g = this.guests.get(id);
    if (!g || !this.display.has(id)) return null;
    return this.camera.planeToScreen(g.px, g.py - this.atlas.figureH * g.height * g.k * 0.55);
  }

  /** Screen point just above an agent's head marker (for name tags). */
  agentHeadScreenPosition(id: Id): ScreenPt | null {
    const g = this.guests.get(id);
    if (!g || !this.display.has(id)) return null;
    return this.camera.planeToScreen(g.px, g.py - this.atlas.figureH * g.height * g.k - 1.15 * g.k);
  }

  /** Screen anchor (top of the structure) for a place label. */
  placeAnchorScreen(placeId: Id, fallback: Vec2): ScreenPt {
    const a = this.anchors.get(placeId);
    return a ? this.camera.worldToScreen(a.p, a.z) : this.camera.worldToScreen(fallback, 2.5);
  }

  /** Front-most guest under a screen point (generous, screen-space hit area). */
  pickAt(screen: ScreenPt): Id | null {
    const cam = this.camera;
    let best: Id | null = null; let bestD = Infinity; let bestZ = -Infinity;
    for (const [id, g] of this.guests) {
      if (!this.display.has(id) || !g.c.visible) continue;
      const hPx = this.atlas.figureH * g.height * g.k * cam.scale;
      const fx = g.px * cam.scale + cam.offsetX; const fy = g.py * cam.scale + cam.offsetY;
      const cx = fx; const cy = fy - hPx * 0.55;
      const dx = screen.x - cx; const dy = (screen.y - cy) * (hPx > 24 ? 0.5 : 0.8);
      const r = Math.max(13, hPx * 0.5);
      const d = Math.hypot(dx, dy);
      if (d > r) continue;
      if (d < bestD - 0.5 || (Math.abs(d - bestD) <= 0.5 && g.z > bestZ)) { best = id; bestD = d; bestZ = g.z; }
    }
    return best;
  }

  private guestFor(id: Id): Guest {
    let g = this.guests.get(id);
    if (g) return g;
    const h = hashStr(id);
    const variant = Math.floor(h * PERSON_VARIANTS) % PERSON_VARIANTS;
    const pf = this.atlas.person[variant]![0]!; const cf = this.atlas.cloth[0]!;
    const person = new Sprite(pf.tex); person.anchor.set(pf.ax, pf.ay);
    const cloth = new Sprite(cf.tex); cloth.anchor.set(cf.ax, cf.ay);
    const c = new Container(); c.addChild(person, cloth);
    const df = this.atlas.decal.circle;
    const decal = new Sprite(df.tex); decal.anchor.set(df.ax, df.ay);
    this.objects.addChild(c); this.decals.addChild(decal);
    g = { c, person, cloth, decal, variant, height: 0.9 + ((h * 997) % 1) * 0.17, phase: (h * 13) % 4, face: h > 0.5 ? 1 : -1, faceAcc: 0, off: { x: 0, y: 0, vx: 0, vy: 0 }, lastX: NaN, lastY: NaN, px: 0, py: 0, k: 1, z: 0 };
    this.guests.set(id, g);
    return g;
  }

  private frame() {
    if (this.destroyed) return;
    const now = performance.now();
    const renderSim = this.clock.tick(now);
    this.renderSim = renderSim;
    const dtS = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    const walkable = this.init.walkable;
    const ex = this.clock.extrapolation;
    this.applyLighting(this.hourOverride ?? this.openHour + renderSim / 3_600_000, now);
    const gt = this.guestTint;
    const cam = this.camera;
    const proj = this.proj;
    const W = this.init.grid.width;
    const k = Math.max(1, MIN_FIGURE_PX / (this.atlas.figureH * cam.scale));
    const base = 1 / ATLAS_RES;
    for (const [id, track] of this.tracks) {
      const pose = track.at(renderSim, ex, walkable);
      const view = this.views.get(id);
      if (!view) continue;
      const g = this.guestFor(id);
      dampOffset(g.off, 0.22, dtS);
      const x = pose.pos.xM + g.off.x; const y = pose.pos.yM + g.off.y;
      this.display.set(id, g.off.x || g.off.y ? { xM: x, yM: y } : pose.pos);
      const style = STATE_STYLE[pose.state];
      let tint = style.color; let alpha = 1; let shape: Shape = style.shape;
      if (this.colorMode === 'experience') tint = experienceColor(view.experienceValue);
      if (this.colorMode === 'satisfaction') {
        if (!view.rating) { tint = UNRATED_COLOR; shape = 'hollow'; }
        else { tint = satisfactionColor(view.rating.value); if (this.nowSimMs - view.rating.atMs > STALE_RATING_MS) alpha = 0.5; }
      }
      // Walk cycle and facing from the displayed motion.
      const dx = Number.isNaN(g.lastX) ? 0 : x - g.lastX; const dy = Number.isNaN(g.lastY) ? 0 : y - g.lastY;
      const moved = Math.hypot(dx, dy);
      g.lastX = x; g.lastY = y;
      let p: Pose = 'stand';
      if (pose.state === 'resting') p = 'sit';
      else if (moved > 0.0005 && moved < 4 && MOVING_STATES.has(pose.state)) {
        // Stride phase from displayed distance, capped so fast playback still reads as walking.
        g.phase = (g.phase + Math.min(moved * 2.4, dtS * 9)) % 4;
        p = WALK_CYCLE[Math.floor(g.phase)]!;
        // Facing: accumulate screen-horizontal motion and flip with hysteresis (no flicker).
        g.faceAcc = g.faceAcc * 0.85 + (dx - dy);
        if (g.faceAcc > 0.04) g.face = 1; else if (g.faceAcc < -0.04) g.face = -1;
      } else if (pose.state === 'queueing' && view.targetPlaceId) {
        // Waiting in line: stand still facing the attraction.
        const t = this.placeEntrance.get(view.targetPlaceId);
        if (t) { const du = (t.xM - t.yM) - (x - y); if (Math.abs(du) > 0.3) g.face = du > 0 ? 1 : -1; }
      }
      const pi = POSES.indexOf(p);
      const pf = this.atlas.person[g.variant]![pi]!; const cf = this.atlas.cloth[pi]!;
      if (g.person.texture !== pf.tex) g.person.texture = pf.tex;
      if (g.cloth.texture !== cf.tex) g.cloth.texture = cf.tex;
      g.cloth.tint = gt === 0xffffff ? tint : mulColor(tint, gt);
      if (g.person.tint !== gt) g.person.tint = gt;
      const px = proj.px(x, y); const py = proj.py(x, y);
      g.px = px; g.py = py; g.k = k;
      const s = base * k * g.height;
      g.c.position.set(px, py);
      g.c.scale.set(s * g.face, s);
      // Guests inside a ride/show footprint are drawn x-ray over the structure.
      const cell = Math.floor(y) * W + Math.floor(x);
      const inside = this.structureAt[cell] ?? -1;
      const ghost = pose.state === 'not_arrived' || pose.state === 'left';
      let z: number;
      if (inside >= 0 && INSIDE_STATES.has(pose.state)) { z = this.structures[inside]!.depth + 0.5; alpha *= 0.45; }
      else z = this.depthFor(x, y, px, py, 0.4 * k, this.atlas.figureH * k);
      if (ghost) alpha *= 0.35;
      g.z = z;
      if (g.c.zIndex !== z) g.c.zIndex = z;
      g.c.alpha = alpha;
      const df = this.atlas.decal[shape];
      if (g.decal.texture !== df.tex) g.decal.texture = df.tex;
      g.decal.tint = tint;
      g.decal.alpha = (inside >= 0 && INSIDE_STATES.has(pose.state)) ? 0 : alpha;
      g.decal.position.set(px, py);
      g.decal.scale.set(base * Math.min(k, 2.2));
    }
    if (this.follow && this.selected) {
      const g = this.guests.get(this.selected);
      if (g) { cam.plane.offsetX += (cam.viewW / 2 - g.px * cam.scale - cam.plane.offsetX) * 0.12; cam.plane.offsetY += (cam.viewH / 2 - (g.py - 1.2) * cam.scale - cam.plane.offsetY) * 0.12; this.init.onCameraChange(); }
    }
    this.world.position.set(cam.offsetX, cam.offsetY);
    this.world.scale.set(cam.scale);
    this.drawMarkers(now);
  }

  private lampAlpha(lit: number) {
    for (let i = 0; i < this.lampGlows.length; i++) this.lampGlows[i]!.alpha = lit * (i % 2 === 0 ? 0.45 : 1);
  }

  /**
   * Render one still frame (static previews): park fitted, lighting at `hour` (default: the
   * opening hour), no guests, no animation. Returns the camera transform used, so overlays can
   * be drawn with the same projection.
   */
  renderStill(hour?: number): { canvas: HTMLCanvasElement; scale: number; offsetX: number; offsetY: number } {
    const now = performance.now();
    this.applyLighting(hour ?? this.openHour, now);
    for (const b of this.beams) b.g.visible = false;
    this.world.position.set(this.camera.offsetX, this.camera.offsetY);
    this.world.scale.set(this.camera.scale);
    this.app.renderer.render(this.app.stage);
    const out = document.createElement('canvas');
    out.width = this.app.canvas.width; out.height = this.app.canvas.height;
    out.getContext('2d')?.drawImage(this.app.canvas, 0, 0);
    return { canvas: out, scale: this.camera.scale, offsetX: this.camera.offsetX, offsetY: this.camera.offsetY };
  }

  /** Debug: render clock state (display/target sim ms, playout buffer, cadence estimates). */
  get clockInfo() { return { ...this.clock.info, epoch: this.epoch, agents: this.tracks.size }; }

  /** Local time of day shown by the scene (hours, 0-24) and its lighting phase. */
  get timeOfDay(): { hour: number; phase: Lighting['phase']; lights: number } {
    return { hour: this.light.hour, phase: this.light.phase, lights: this.light.lights };
  }
  /** Debug / preview: pin the lighting to a local hour (null follows the run clock). */
  setHourOverride(hour: number | null) { this.hourOverride = hour; }

  private applyLighting(hour: number, now: number) {
    const L = lightingAt(hour);
    this.light = L;
    const world = tintNum(L.world);
    const key = world ^ Math.round(L.lights * 255) << 24 ^ Math.round(L.shadow * 255) << 2;
    if (key !== this.lightKey) {
      this.lightKey = key;
      for (const o of this.litLayers) o.tint = world;
      this.guestTint = tintNum(L.guest);
      this.shadowLayer.alpha = L.shadow;
      const lit = Math.max(0, Math.min(1, L.lights));
      this.poolLayer.alpha = lit; this.poolLayer.visible = lit > 0.01;
      for (const gl of this.glowLayers) { gl.alpha = lit; gl.visible = lit > 0.01; }
      for (const h of this.lampGlows) h.visible = lit > 0.01;
      this.lampAlpha(lit);
      this.app.renderer.background.color = (Math.round(L.sky[0]) << 16) | (Math.round(L.sky[1]) << 8) | Math.round(L.sky[2]);
      this.haze.tint = (Math.round(L.haze[0]) << 16) | (Math.round(L.haze[1]) << 8) | Math.round(L.haze[2]);
      this.haze.alpha = L.hazeAlpha;
    }
    this.haze.width = this.camera.viewW * 1.25; this.haze.height = this.camera.viewH * 1.1;
    // Lighthouse beams sweep slowly (wall-clock driven, purely decorative).
    for (const b of this.beams) {
      b.g.clear();
      if (L.lights < 0.05) { b.g.visible = false; continue; }
      b.g.visible = true;
      const [x, y, z] = b.at; const p = this.proj;
      const a = (now / 5200) % (Math.PI * 2); const len = 70; const sp = 0.07;
      const ox = p.px(x, y); const oy = p.py(x, y, z);
      for (const [w, al] of [[1, 0.1], [0.45, 0.16]] as const) {
        const a0 = a - sp * w; const a1 = a + sp * w;
        b.g.poly([ox, oy, p.px(x + Math.cos(a0) * len, y + Math.sin(a0) * len), p.py(x + Math.cos(a0) * len, y + Math.sin(a0) * len, z),
          p.px(x + Math.cos(a1) * len, y + Math.sin(a1) * len), p.py(x + Math.cos(a1) * len, y + Math.sin(a1) * len, z)]).fill({ color: 0xfff0c8, alpha: al * L.lights });
      }
    }
  }

  private drawMarkers(now: number) {
    const o = this.groundFx; const t = this.topFx;
    o.clear(); t.clear();
    const px1 = 1 / this.camera.scale;
    const ring = (g: Guest, r: number, color: number, width: number, alpha: number) => {
      const rx = r * g.k * 1.25; const ry = rx * 0.5;
      o.ellipse(g.px, g.py, rx, ry).stroke({ color: 0x000000, width: width + 2 * px1, alpha: alpha * 0.45 });
      o.ellipse(g.px, g.py, rx, ry).stroke({ color, width, alpha });
    };
    if (this.hovered && this.hovered !== this.selected) {
      const g = this.guests.get(this.hovered);
      if (g && this.display.has(this.hovered)) ring(g, 0.75, 0xf2ead8, 1.5 * px1, 0.75);
    }
    if (!this.selected) return;
    const sel = this.guests.get(this.selected);
    if (!sel || !this.display.has(this.selected)) return;
    for (const gid of this.groupIds) {
      if (gid === this.selected) continue;
      const m = this.guests.get(gid);
      if (!m || !this.display.has(gid)) continue;
      o.moveTo(sel.px, sel.py).lineTo(m.px, m.py).stroke({ color: 0xf2ead8, width: 1.2 * px1, alpha: 0.45 });
      ring(m, 0.7, 0xf2ead8, 1.3 * px1, 0.8);
    }
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);
    ring(sel, 0.95 + pulse * 0.12, 0xffffff, 2.2 * px1, 1);
    ring(sel, 1.35 + pulse * 0.35, 0xf3d79a, 1.2 * px1, 0.35 + 0.35 * (1 - pulse));
    // Marker above the head.
    const headY = sel.py - this.atlas.figureH * sel.height * sel.k - 0.45 * sel.k - pulse * 0.15 * sel.k;
    const w = 0.42 * sel.k; const h = 0.5 * sel.k;
    t.poly([sel.px - w, headY - h, sel.px + w, headY - h, sel.px, headY]).fill({ color: 0xf3d79a }).stroke({ color: 0x1b1a17, width: 1.4 * px1 });
  }

  private attachInput(canvas: HTMLCanvasElement) {
    const pointers = new Map<number, ScreenPt>();
    let dragged = false;
    let start: ScreenPt | null = null;
    let pinch: number | null = null;
    let hoverRaf: number | null = null;
    let hoverAt: ScreenPt | null = null;
    const local = (e: PointerEvent | WheelEvent): ScreenPt => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const setHover = (id: Id | null) => {
      if (id === this.hovered) return;
      this.hovered = id;
      canvas.style.cursor = id ? 'pointer' : 'grab';
      this.init.onHover?.(id);
    };
    canvas.style.cursor = 'grab';
    const down = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      if (pointers.size === 1) { start = local(e); dragged = false; }
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y); }
    };
    const move = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        if (e.pointerType === 'mouse') {
          hoverAt = local(e);
          if (hoverRaf === null) hoverRaf = requestAnimationFrame(() => { hoverRaf = null; if (hoverAt) setHover(this.pickAt(hoverAt)); });
        }
        return;
      }
      const cur = local(e);
      pointers.set(e.pointerId, cur);
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        this.camera.zoomAt({ x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 }, d / pinch);
        pinch = d;
        dragged = true;
      } else if (pointers.size === 1) {
        if (start && Math.hypot(cur.x - start.x, cur.y - start.y) > 4) { if (!dragged) { this.setFollow(false); canvas.style.cursor = 'grabbing'; } dragged = true; }
        if (dragged) this.camera.pan(cur.x - prev.x, cur.y - prev.y);
      }
      this.init.onCameraChange();
    };
    const up = (e: PointerEvent) => {
      const p = local(e);
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) {
        canvas.style.cursor = this.hovered ? 'pointer' : 'grab';
        if (!dragged) this.init.onPick(this.pickAt(p));
      }
    };
    const leave = () => setHover(null);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const sel = this.follow && this.selected ? this.guests.get(this.selected) : null;
      const at = sel ? this.camera.planeToScreen(sel.px, sel.py) : local(e);
      this.camera.zoomAt(at, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
      this.init.onCameraChange();
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('wheel', wheel, { passive: false });
    this.cleanup.push(() => {
      if (hoverRaf !== null) cancelAnimationFrame(hoverRaf);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('wheel', wheel);
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cleanup.forEach((c) => c());
    if (this.app) {
      this.app.canvas.remove();
      this.app.destroy(true, { children: true, texture: true, textureSource: true });
    }
    for (const c of this.releasables) { c.width = 0; c.height = 0; }
    this.releasables = [];
  }
}

/** True for software WebGL (SwiftShader / llvmpipe) or the canvas fallback renderer. */
function softwareRenderer(app: Application): boolean {
  const gl = (app.renderer as unknown as { gl?: WebGLRenderingContext }).gl;
  if (!gl) return true;
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return /swiftshader|llvmpipe|software|basic render/i.test(name);
  } catch { return false; }
}

/** Multiply two 0xRRGGBB colours. */
function mulColor(a: number, b: number): number {
  const r = (((a >> 16) & 255) * ((b >> 16) & 255)) / 255; const g = (((a >> 8) & 255) * ((b >> 8) & 255)) / 255; const bl = ((a & 255) * (b & 255)) / 255;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}
