/**
 * The single world<->screen transform. World units are metres (x right, y down, origin
 * top-left, same as the wire). Screen units are CSS pixels; device pixel ratio is applied
 * only by the renderer backend, never mixed into world maths.
 */
import type { Vec2 } from '../../contract/behavior-v1';

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
