/**
 * 2:1 dimetric ("classic isometric") projection. World units are metres on the ground
 * (x right/east, y down/south, origin top-left, as on the wire) plus height z in metres.
 * Plane units are the projected 2D space the scene draws in; the camera maps plane units
 * to CSS pixels. One metre along x moves (+1, +0.5) on the plane, one metre along y moves
 * (-1, +0.5), one metre up moves (0, -Z_SCALE).
 */
import type { Vec2 } from '../../contract/behavior-v1';

export const Z_SCALE = 1.22;
/** Head-room above the park's north corner for tall structures. */
export const TOP_MARGIN_M = 44;
/** Depth of the model base slab drawn below the park edges. */
export const SLAB_M = 3.5;

export type PlanePt = { x: number; y: number };

export class IsoProjection {
  readonly planeW: number;
  readonly planeH: number;
  private readonly top: number;
  constructor(readonly worldW: number, readonly worldH: number) {
    this.top = TOP_MARGIN_M * Z_SCALE * 0.6;
    this.planeW = worldW + worldH;
    this.planeH = (worldW + worldH) / 2 + this.top + SLAB_M * Z_SCALE + 2;
  }
  /** Ground/height (metres) -> plane. */
  px(x: number, y: number): number { return x - y + this.worldH; }
  py(x: number, y: number, z = 0): number { return (x + y) / 2 + this.top - z * Z_SCALE; }
  toPlane(x: number, y: number, z = 0): PlanePt { return { x: this.px(x, y), y: this.py(x, y, z) }; }
  /** Plane -> ground point (z = 0). */
  toGround(p: PlanePt): Vec2 {
    const d = p.x - this.worldH; // x - y
    const s = 2 * (p.y - this.top); // x + y
    return { xM: (s + d) / 2, yM: (s - d) / 2 };
  }
  /** Affine matrix (a, b, c, d, tx, ty) mapping a top-down image at `pxPerM` onto the ground plane. */
  groundMatrix(pxPerM: number): [number, number, number, number, number, number] {
    return [1 / pxPerM, 0.5 / pxPerM, -1 / pxPerM, 0.5 / pxPerM, this.worldH, this.top];
  }
}
