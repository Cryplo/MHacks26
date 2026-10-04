/**
 * Okabe-Ito based, colour-vision-safe encodings. Every state is ALSO encoded by shape, and
 * every legend entry has text, so no information depends on colour alone.
 */
import type { AgentView } from '../../contract/behavior-v1';

export type ColorMode = 'state' | 'experience' | 'satisfaction';
export type Shape = 'circle' | 'square' | 'triangle' | 'diamond' | 'ring' | 'hollow';

export const STATE_STYLE: Record<AgentView['state'], { shape: Shape; color: number; label: string; family: string }> = {
  walking: { shape: 'circle', color: 0x0072b2, label: 'Walking', family: 'moving' },
  browsing: { shape: 'circle', color: 0x56b4e9, label: 'Browsing', family: 'moving' },
  deciding: { shape: 'circle', color: 0xcc79a7, label: 'Deciding', family: 'moving' },
  queueing: { shape: 'square', color: 0xe69f00, label: 'In a queue', family: 'queue' },
  riding: { shape: 'triangle', color: 0xd55e00, label: 'Riding', family: 'service' },
  watching: { shape: 'triangle', color: 0xd55e00, label: 'Watching a show', family: 'service' },
  eating: { shape: 'diamond', color: 0x009e73, label: 'Eating', family: 'purchase' },
  shopping: { shape: 'diamond', color: 0x009e73, label: 'Shopping', family: 'purchase' },
  resting: { shape: 'ring', color: 0xf0e442, label: 'Resting', family: 'rest' },
  not_arrived: { shape: 'hollow', color: 0x999999, label: 'Not arrived', family: 'other' },
  left: { shape: 'hollow', color: 0x999999, label: 'Left', family: 'other' },
};

/** Modeled experience ledger bins (model output, not a measurement). */
export const EXPERIENCE_BINS: { max: number; color: number; label: string }[] = [
  { max: -10, color: 0xd55e00, label: 'below -10 (strongly negative)' },
  { max: 0, color: 0xe69f00, label: '-10 to 0' },
  { max: 15, color: 0xf0e442, label: '0 to 15' },
  { max: 40, color: 0x56b4e9, label: '15 to 40' },
  { max: Infinity, color: 0x0072b2, label: 'above 40' },
];
export const experienceColor = (v: number) => EXPERIENCE_BINS.find((b) => v <= b.max)!.color;

/** Synthetic satisfaction ratings mapped 0-100 (periodic measurements, not continuous). */
export const SATISFACTION_BINS: { max: number; color: number; label: string }[] = [
  { max: 12.5, color: 0xd55e00, label: '0 (lowest level)' },
  { max: 37.5, color: 0xe69f00, label: '25' },
  { max: 62.5, color: 0xf0e442, label: '50' },
  { max: 87.5, color: 0x56b4e9, label: '75' },
  { max: Infinity, color: 0x0072b2, label: '100 (highest level)' },
];
export const satisfactionColor = (v: number) => SATISFACTION_BINS.find((b) => v <= b.max)!.color;
export const UNRATED_COLOR = 0xbbbbbb;
export const STALE_RATING_MS = 30 * 60_000;

export const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
export const SHAPE_GLYPH: Record<Shape, string> = { circle: '●', square: '■', triangle: '▲', diamond: '◆', ring: '○', hollow: '◌' };
