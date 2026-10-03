/**
 * PixiJS scene for the live park. Canvas animation runs on Pixi's ticker, separate from
 * React; React only pushes authoritative samples and settings in. Sprites are pooled per
 * agent, textures are generated once per shape and tinted, and all positions go through
 * the single Camera transform.
 */
import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { AgentView, Id, Vec2 } from '../../contract/behavior-v1';
import { Camera, type ScreenPt } from './camera';
import { experienceColor, satisfactionColor, STALE_RATING_MS, STATE_STYLE, UNRATED_COLOR, type ColorMode, type Shape } from './colors';
import { displayPose, pushSample, RenderClock, type Track, type Walkable } from './interpolation';
import { pickAgent } from './picking';

export type SceneInit = {
  host: HTMLElement;
  mapCanvas: HTMLCanvasElement; // painted at `pxPerCell` per metre
  pxPerCell: number;
  worldW: number;
  worldH: number;
  walkable: Walkable;
  onPick: (agentId: Id | null) => void;
  onFailure: (message: string) => void;
  onCameraChange: () => void;
};

const TEX_PX = 24;

export class ParkScene {
  readonly camera: Camera;
  private app!: Application;
  private world = new Container();
  private agentLayer = new Container();
  private overlay = new Graphics();
  private textures = new Map<Shape, Texture>();
  private sprites = new Map<Id, Sprite>();
  private tracks = new Map<Id, Track>();
  private views = new Map<Id, AgentView>();
  private display = new Map<Id, Vec2>();
  private clock = new RenderClock(5000);
  private colorMode: ColorMode = 'state';
  private nowSimMs = 0;
  private selected: Id | null = null;
  private groupIds: Id[] = [];
  private epoch = -1;
  private destroyed = false;
  private cleanup: (() => void)[] = [];
  private lastAgents: ReadonlyMap<Id, AgentView> | null = null;

  private constructor(private readonly init: SceneInit) {
    this.camera = new Camera(init.worldW, init.worldH);
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
      resolution: Math.min(3, window.devicePixelRatio || 1), background: '#24331f', preference: 'webgl',
    });
    if (this.destroyed) { app.destroy(true); return; }
    this.app = app;
    const canvas = app.canvas;
    canvas.setAttribute('aria-hidden', 'true'); // the accessible alternative is the guest list
    canvas.tabIndex = -1;
    host.appendChild(canvas);

    const mapTex = Texture.from(this.init.mapCanvas);
    mapTex.source.scaleMode = 'nearest';
    const map = new Sprite(mapTex);
    map.scale.set(1 / this.init.pxPerCell); // map in metres
    this.world.addChild(map, this.agentLayer, this.overlay);
    app.stage.addChild(this.world);

    for (const shape of ['circle', 'square', 'triangle', 'diamond', 'ring', 'hollow'] as Shape[]) {
      const g = new Graphics();
      const c = TEX_PX / 2;
      const r = TEX_PX / 2 - 3;
      if (shape === 'circle') g.circle(c, c, r).fill(0xffffff).stroke({ width: 2.5, color: 0x101418 });
      if (shape === 'square') g.rect(3, 3, TEX_PX - 6, TEX_PX - 6).fill(0xffffff).stroke({ width: 2.5, color: 0x101418 });
      if (shape === 'triangle') g.poly([c, 2, TEX_PX - 2, TEX_PX - 3, 2, TEX_PX - 3]).fill(0xffffff).stroke({ width: 2.5, color: 0x101418 });
      if (shape === 'diamond') g.poly([c, 1, TEX_PX - 1, c, c, TEX_PX - 1, 1, c]).fill(0xffffff).stroke({ width: 2.5, color: 0x101418 });
      if (shape === 'ring') g.circle(c, c, r).fill({ color: 0x101418, alpha: 0.35 }).stroke({ width: 4, color: 0xffffff });
      if (shape === 'hollow') g.circle(c, c, r).stroke({ width: 2, color: 0xffffff });
      this.textures.set(shape, app.renderer.generateTexture({ target: g, resolution: 2, antialias: true }));
      g.destroy();
    }

    this.camera.setViewport(host.clientWidth, host.clientHeight);
    this.camera.fit();
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

  resize() {
    if (!this.app || this.destroyed) return;
    const { clientWidth: w, clientHeight: h } = this.init.host;
    this.app.renderer.resize(Math.max(1, w), Math.max(1, h));
    this.camera.setViewport(w, h);
    this.init.onCameraChange();
  }

  /** Push authoritative agents at the committed sim time. Identity-unchanged agents are skipped. */
  setAgents(agents: ReadonlyMap<Id, AgentView>, simMs: number, epoch: number) {
    if (epoch !== this.epoch) {
      // New snapshot / seek / run switch: no interpolation from previous content.
      this.tracks.clear();
      this.epoch = epoch;
      this.lastAgents = null;
      this.clock.reset(simMs, performance.now());
    }
    const prevAgents = this.lastAgents;
    for (const [id, a] of agents) {
      const track = this.tracks.get(id);
      if (track && prevAgents && prevAgents.get(id) === a) {
        // Unchanged authoritative pose: it was stationary through this committed time.
        if (track.latest.simMs < simMs) this.tracks.set(id, { prev: track.latest, latest: { ...track.latest, simMs }, continuous: true });
        continue;
      }
      this.tracks.set(id, pushSample(track, { simMs, pos: a.position, state: a.state }, this.init.walkable));
      this.views.set(id, a);
    }
    for (const id of [...this.tracks.keys()]) {
      if (!agents.has(id)) {
        this.tracks.delete(id); this.views.delete(id); this.display.delete(id);
        const s = this.sprites.get(id);
        if (s) { s.destroy(); this.sprites.delete(id); }
      }
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
  setSelection(agentId: Id | null, groupIds: Id[]) { this.selected = agentId; this.groupIds = groupIds; }
  getDisplayPositions(): ReadonlyMap<Id, Vec2> { return this.display; }

  zoomBy(factor: number) { this.camera.zoomAt({ x: this.camera.viewW / 2, y: this.camera.viewH / 2 }, factor); this.init.onCameraChange(); }
  panBy(dx: number, dy: number) { this.camera.pan(dx, dy); this.init.onCameraChange(); }
  fit() { this.camera.fit(); this.init.onCameraChange(); }
  centerOn(p: Vec2) { this.camera.centerOn(p); this.init.onCameraChange(); }

  /** Screen position (CSS px, relative to host) for an agent as currently displayed. */
  agentScreenPosition(id: Id): ScreenPt | null {
    const p = this.display.get(id);
    return p ? this.camera.worldToScreen(p) : null;
  }

  pickAt(screen: ScreenPt): Id | null {
    const world = this.camera.screenToWorld(screen);
    return pickAgent(this.display, world, Math.max(0.9, this.camera.pxToMetres(10)));
  }

  private frame() {
    if (this.destroyed) return;
    const renderSim = this.clock.tick(performance.now());
    const cam = this.camera;
    this.world.position.set(cam.offsetX, cam.offsetY);
    this.world.scale.set(cam.scale);
    const sizeM = Math.max(1.0, 9 / cam.scale);
    const spriteScale = sizeM / TEX_PX;
    for (const [id, track] of this.tracks) {
      const pose = displayPose(track, renderSim);
      this.display.set(id, pose.pos);
      let s = this.sprites.get(id);
      const view = this.views.get(id);
      if (!view) continue;
      const style = STATE_STYLE[pose.state];
      let tint = style.color;
      let alpha = 1;
      let shape: Shape = style.shape;
      if (this.colorMode === 'experience') tint = experienceColor(view.experienceValue);
      if (this.colorMode === 'satisfaction') {
        if (!view.rating) { tint = UNRATED_COLOR; shape = 'hollow'; }
        else {
          tint = satisfactionColor(view.rating.value);
          if (this.nowSimMs - view.rating.atMs > STALE_RATING_MS) alpha = 0.45;
        }
      }
      const tex = this.textures.get(shape)!;
      if (!s) {
        s = new Sprite(tex);
        s.anchor.set(0.5);
        this.agentLayer.addChild(s);
        this.sprites.set(id, s);
      } else if (s.texture !== tex) s.texture = tex;
      s.tint = tint;
      s.alpha = alpha;
      s.scale.set(spriteScale);
      s.position.set(pose.pos.xM, pose.pos.yM);
    }
    const o = this.overlay;
    o.clear();
    if (this.selected) {
      for (const gid of this.groupIds) {
        const p = this.display.get(gid);
        if (p && gid !== this.selected) o.circle(p.xM, p.yM, sizeM * 0.85).stroke({ width: Math.max(0.15, 2 / cam.scale), color: 0xffffff, alpha: 0.9 });
      }
      const p = this.display.get(this.selected);
      if (p) {
        o.circle(p.xM, p.yM, sizeM * 1.1).stroke({ width: Math.max(0.25, 3 / cam.scale), color: 0x000000 });
        o.circle(p.xM, p.yM, sizeM * 1.1).stroke({ width: Math.max(0.12, 1.5 / cam.scale), color: 0xffffff });
      }
    }
  }

  private attachInput(canvas: HTMLCanvasElement) {
    const pointers = new Map<number, ScreenPt>();
    let dragged = false;
    let start: ScreenPt | null = null;
    let pinch: number | null = null;
    const local = (e: PointerEvent | WheelEvent): ScreenPt => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      if (pointers.size === 1) { start = local(e); dragged = false; }
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y); }
    };
    const move = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const cur = local(e);
      pointers.set(e.pointerId, cur);
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        this.camera.zoomAt({ x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 }, d / pinch);
        pinch = d;
        dragged = true;
      } else if (pointers.size === 1) {
        if (start && Math.hypot(cur.x - start.x, cur.y - start.y) > 4) dragged = true;
        if (dragged) this.camera.pan(cur.x - prev.x, cur.y - prev.y);
      }
      this.init.onCameraChange();
    };
    const up = (e: PointerEvent) => {
      const p = local(e);
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0 && !dragged) this.init.onPick(this.pickAt(p));
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.camera.zoomAt(local(e), Math.exp(-e.deltaY * 0.0015));
      this.init.onCameraChange();
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    this.cleanup.push(() => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('wheel', wheel);
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cleanup.forEach((c) => c());
    if (this.app) {
      this.app.canvas.remove();
      this.app.destroy(true, { children: true, texture: true });
    }
  }
}
