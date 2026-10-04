/**
 * The single world<->screen transform. World units are metres (x right, y down, origin
 * top-left, same as the wire). Screen units are CSS pixels; device pixel ratio is applied
 * only by the renderer backend, never mixed into world maths.
 */
import type { Vec2 } from '../../contract/behavior-v1';
import type { IsoProjection } from './iso';

export type ScreenPt = { x: number; y: number };

export class Camera {
  scale = 1; // CSS px per metre
  offsetX = 0; // CSS px
  offsetY = 0;
  viewW = 1;
  viewH = 1;
  minScale = 0.5;
  maxScale = 60;
  /** True once the user pans/zooms; until then resizes keep the whole park fitted. */
  userMoved = false;

  constructor(readonly worldW: number, readonly worldH: number) {}

  setViewport(w: number, h: number) {
    const center = this.viewW > 1 ? this.screenToWorld({ x: this.viewW / 2, y: this.viewH / 2 }) : null;
    this.viewW = Math.max(1, w);
    this.viewH = Math.max(1, h);
    if (center && this.userMoved) this.centerOn(center); else this.fit();
  }

  fit(padding = 8) {
    this.userMoved = false;
    const sx = (this.viewW - padding * 2) / this.worldW;
    const sy = (this.viewH - padding * 2) / this.worldH;
    this.scale = Math.max(0.05, Math.min(sx, sy));
    this.minScale = Math.min(this.scale * 0.8, this.minScale);
    this.offsetX = (this.viewW - this.worldW * this.scale) / 2;
    this.offsetY = (this.viewH - this.worldH * this.scale) / 2;
  }

  centerOn(p: Vec2) {
    this.offsetX = this.viewW / 2 - p.xM * this.scale;
    this.offsetY = this.viewH / 2 - p.yM * this.scale;
  }

  worldToScreen(p: Vec2): ScreenPt {
    return { x: p.xM * this.scale + this.offsetX, y: p.yM * this.scale + this.offsetY };
  }

  screenToWorld(s: ScreenPt): Vec2 {
    return { xM: (s.x - this.offsetX) / this.scale, yM: (s.y - this.offsetY) / this.scale };
  }

  /** Zoom keeping the world point under `at` fixed on screen. */
  zoomAt(at: ScreenPt, factor: number) {
    this.userMoved = true;
    const before = this.screenToWorld(at);
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * factor));
    this.offsetX = at.x - before.xM * this.scale;
    this.offsetY = at.y - before.yM * this.scale;
  }

  pan(dx: number, dy: number) {
    this.userMoved = true;
    this.offsetX += dx;
    this.offsetY += dy;
  }

  /** Metres covered by `px` CSS pixels at the current zoom (for hit radii). */
  pxToMetres(px: number) {
    return px / this.scale;
  }
}


/**
 * Camera over the isometric plane: the same single pan/zoom transform (a plain Camera over
 * projected plane units) composed with the fixed iso projection. `worldToScreen` takes a
 * ground point (plus optional height); `screenToWorld` returns the ground point under it.
 */
export class IsoCamera {
  readonly plane: Camera;
  constructor(readonly proj: IsoProjection) {
    this.plane = new Camera(proj.planeW, proj.planeH);
    this.plane.maxScale = 48;
  }
  get scale() { return this.plane.scale; }
  get offsetX() { return this.plane.offsetX; }
  get offsetY() { return this.plane.offsetY; }
  get viewW() { return this.plane.viewW; }
  get viewH() { return this.plane.viewH; }
  get userMoved() { return this.plane.userMoved; }
  /** Tight plane-space box around the visible content (park + tallest structures). */
  content: { x0: number; y0: number; x1: number; y1: number } | null = null;
  setViewport(w: number, h: number) {
    this.plane.setViewport(w, h);
    if (!this.plane.userMoved && this.content) this.fit();
  }
  fit(padding = 8) {
    const c = this.content;
    if (!c) { this.plane.fit(padding); return; }
    const pl = this.plane;
    pl.userMoved = false;
    const s = Math.max(0.05, Math.min((pl.viewW - padding * 2) / (c.x1 - c.x0), (pl.viewH - padding * 2) / (c.y1 - c.y0)));
    pl.scale = s;
    pl.minScale = Math.min(s * 0.8, pl.minScale);
    pl.offsetX = (pl.viewW - (c.x1 - c.x0) * s) / 2 - c.x0 * s;
    pl.offsetY = (pl.viewH - (c.y1 - c.y0) * s) / 2 - c.y0 * s;
  }
  zoomAt(at: ScreenPt, factor: number) { this.plane.zoomAt(at, factor); }
  pan(dx: number, dy: number) { this.plane.pan(dx, dy); }
  /** Plane point -> screen. */
  planeToScreen(x: number, y: number): ScreenPt { return { x: x * this.plane.scale + this.plane.offsetX, y: y * this.plane.scale + this.plane.offsetY }; }
  worldToScreen(p: Vec2, zM = 0): ScreenPt { return this.planeToScreen(this.proj.px(p.xM, p.yM), this.proj.py(p.xM, p.yM, zM)); }
  screenToWorld(s: ScreenPt): Vec2 {
    const pl = this.plane.screenToWorld(s);
    return this.proj.toGround({ x: pl.xM, y: pl.yM });
  }
  centerOn(p: Vec2, zM = 0) {
    this.plane.centerOn({ xM: this.proj.px(p.xM, p.yM), yM: this.proj.py(p.xM, p.yM, zM) });
  }
  /** Move a fraction of the way toward centring `p` (camera follow). Does not mark user movement. */
  easeToward(p: Vec2, t: number, zM = 0) {
    const tx = this.plane.viewW / 2 - this.proj.px(p.xM, p.yM) * this.plane.scale;
    const ty = this.plane.viewH / 2 - this.proj.py(p.xM, p.yM, zM) * this.plane.scale;
    this.plane.offsetX += (tx - this.plane.offsetX) * t;
    this.plane.offsetY += (ty - this.plane.offsetY) * t;
  }
}
