import { describe, expect, it } from 'vitest';

import { LEVEL_ROUTES, readLevelRoute } from './level-route';

describe('level hash routing', () => {
  it('keeps the root and unknown hashes on Cold Cache', () => {
    expect(readLevelRoute('')).toBe('cold-cache');
    expect(readLevelRoute('#')).toBe('cold-cache');
    expect(readLevelRoute('#cold-cache')).toBe('cold-cache');
    expect(readLevelRoute('#unknown')).toBe('cold-cache');
  });

  it('maps the explicit Live Audience hash without changing the default', () => {
    expect(readLevelRoute('#live-audience')).toBe('live-audience');
    expect(readLevelRoute('#LIVE-AUDIENCE')).toBe('live-audience');
    expect(readLevelRoute('#audience')).toBe('cold-cache');
    expect(readLevelRoute('')).toBe('cold-cache');
  });

  it('maps the explicit Parcel Pulse hash', () => {
    expect(readLevelRoute('#parcel-pulse')).toBe('parcel-pulse');
    expect(readLevelRoute('#PARCEL-PULSE')).toBe('parcel-pulse');
  });

  it('maps the Image Atlas hash', () => {
    expect(readLevelRoute('#image-atlas')).toBe('image-atlas');
    expect(readLevelRoute('#IMAGE-ATLAS')).toBe('image-atlas');
    expect(readLevelRoute('#image')).toBe('cold-cache');
  });

  it('maps the explicit Live Scoreboard hash without breaking old links', () => {
    expect(readLevelRoute('#live-scoreboard')).toBe('live-scoreboard');
    expect(readLevelRoute('#LIVE-SCOREBOARD')).toBe('live-scoreboard');
    expect(readLevelRoute('')).toBe('cold-cache');
    expect(readLevelRoute('#cold-cache')).toBe('cold-cache');
  });

  it('lists every playable level with Live Audience first', () => {
    expect(LEVEL_ROUTES.map((route) => route.id)).toEqual([
      'live-audience',
      'live-scoreboard',
      'cold-cache',
      'parcel-pulse',
      'image-atlas',
    ]);
    expect(LEVEL_ROUTES.map((route) => route.title)).toEqual([
      'Live Audience',
      'Live Scoreboard',
      'Cold Cache',
      'Parcel Pulse',
      'Image Atlas',
    ]);
    expect(LEVEL_ROUTES[0]?.hash).toBe('#live-audience');
    expect(new Set(LEVEL_ROUTES.map((route) => route.hash)).size).toBe(5);
  });
});
