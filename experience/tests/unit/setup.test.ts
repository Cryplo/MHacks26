/** C-03 crowd controls, C-12/13 draft descriptions, C-15 share tokens. */
import { describe, expect, it } from 'vitest';
import type { ParkBundle } from '../../contract/behavior-v1';
import bundle from '../../fixtures/parks/harbor-lights-stage1.bundle.json';
import { defaultMix, fitMix, sharesFor, sumMix, validateCrowd } from '../../src/features/setup/crowd';
import { describeChange } from '../../src/features/scenarios/describe';
import { buildShareLink, generateShareToken, readShareFragment, scrubFragment } from '../../src/features/sharing/shareToken';
import { sha256Hex } from '../../src/domain/canonical';

const park = bundle as unknown as ParkBundle;

describe('crowd model (C-03)', () => {
  it('sliders are guests; shares are guests / total', () => {
    const mix = defaultMix(300);
    expect(sumMix(mix)).toBe(300);
    const shares = sharesFor(mix, 300);
    expect(shares.young_family).toBeCloseTo(mix.young_family / 300);
    expect(Math.abs(Object.values(shares).reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-9);
  });
  it('flags mismatched totals, all-zero, impossible counts and infeasible families', () => {
    expect(validateCrowd(300, defaultMix(300), 400).errors).toEqual([]);
    expect(validateCrowd(300, defaultMix(250), 400).errors[0]).toMatch(/assign 250 guests/);
    expect(validateCrowd(300, { young_family: 0, teens: 0, couple: 0, thrill_seekers: 0, seniors: 0, solo: 0 }, 400).errors).toContain('Assign guests to at least one archetype.');
    expect(validateCrowd(500, defaultMix(500), 400).errors[0]).toMatch(/at most 400/);
    expect(validateCrowd(0, defaultMix(0), 400).errors.length).toBeGreaterThan(0);
    expect(validateCrowd(50, defaultMix(50), 400).warnings[0]).toMatch(/under 100/);
    expect(validateCrowd(1800, defaultMix(1800), 2000).warnings[0]).toMatch(/above 1500/);
    expect(validateCrowd(1000, defaultMix(1000), 2000).warnings).toEqual([]);
    expect(validateCrowd(10, { young_family: 2, teens: 0, couple: 8, thrill_seekers: 0, seniors: 0, solo: 0 }, 400).errors.some((e) => /at least 3/.test(e))).toBe(true);
  });
  it('fit-to-size rescales deterministically to the exact total', () => {
    const fitted = fitMix(defaultMix(300), 217);
    expect(sumMix(fitted)).toBe(217);
    expect(fitMix(defaultMix(300), 217)).toEqual(fitted);
  });
});

describe('draft descriptions (C-12/C-13)', () => {
  it('shows dollar units and integer cents for a price change', () => {
    const d = describeChange({ kind: 'pass_price', unitPriceCents: 2500 }, park, false);
    expect(d.value).toMatch(/\$25\.00 per guest \(2500 cents/);
  });
  it('a discount-sounding message without a discount is labeled text-only', () => {
    const d = describeChange({ kind: 'app_message', messageId: 'm', text: '20% off churros!', expiresAtMs: 3600_000, suggestedPlaceId: 'churro_cart', discount: null }, park, false);
    expect(d.notes.join(' ')).toMatch(/changes NO price/);
    expect(d.value).toMatch(/no discount/);
  });
  it('a closure explains release semantics and guest discovery', () => {
    const d = describeChange({ kind: 'closure', placeId: 'coaster_tempest', closed: true }, park, false);
    expect(d.place).toBe('Tempest Coaster');
    expect(d.value).toMatch(/not abandonment/);
  });
});

describe('share tokens (C-15)', () => {
  it('high-entropy base64url tokens; link carries them only in the fragment', async () => {
    const a = generateShareToken(); const b = generateShareToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const link = buildShareLink('https://park.example', a);
    const url = new URL(link);
    expect(url.search).toBe('');
    expect(url.pathname).toBe('/share');
    expect(readShareFragment(url.hash)).toBe(a);
    expect(await sha256Hex(a)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects malformed fragments and role query strings grant nothing', () => {
    expect(readShareFragment('#t=short')).toBeNull();
    expect(readShareFragment('?role=operator')).toBeNull();
    expect(readShareFragment('#role=operator')).toBeNull();
  });
  it('scrubs the fragment from history', () => {
    window.history.replaceState(null, '', '/share?x=1#t=' + 'a'.repeat(43));
    scrubFragment();
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?x=1');
  });
});
