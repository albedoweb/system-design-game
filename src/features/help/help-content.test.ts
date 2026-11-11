import { describe, expect, it } from 'vitest';

import { LEVEL_ROUTES } from '../../parcel/ui/level-route';
import { LEVEL_GUIDE_ORDER, levelGuide } from './help-content';

function guideText(route: (typeof LEVEL_ROUTES)[number]['id']): string {
  const guide = levelGuide(route);
  return [
    guide.title,
    guide.tagline,
    ...guide.sections.flatMap((section) => [
      section.heading,
      ...(section.paragraphs ?? []),
      ...(section.steps ?? []),
      ...(section.bullets ?? []),
      ...(section.note ? [section.note] : []),
    ]),
  ].join('\n');
}

describe('Live Audience help entry', () => {
  it('covers every playable level with Live Audience first', () => {
    expect(LEVEL_GUIDE_ORDER).toEqual(LEVEL_ROUTES.map((route) => route.id));
    expect(LEVEL_GUIDE_ORDER[0]).toBe('live-audience');
    for (const route of LEVEL_ROUTES) {
      const guide = levelGuide(route.id);
      expect(guide.title.length).toBeGreaterThan(0);
      expect(guide.tagline.length).toBeGreaterThan(0);
      expect(guide.sections.length).toBeGreaterThan(0);
    }
  });

  it('keeps the earlier level guides intact and reachable', () => {
    for (const route of [
      'live-scoreboard',
      'cold-cache',
      'parcel-pulse',
      'image-atlas',
    ] as const) {
      expect(levelGuide(route).sections.length).toBeGreaterThan(0);
    }
    expect(guideText('live-scoreboard')).toMatch(/up to 5 seconds behind/);
  });

  it('explains the audience rules without naming a winning design', () => {
    const text = guideText('live-audience');
    expect(text).toMatch(/top 20 of 100 streams/);
    expect(text).toMatch(/previous 15 minutes/);
    expect(text).toMatch(/case selector/);
    expect(text).toMatch(/critical offer cohort/);
    expect(text).toMatch(/5 seconds/);
    expect(text).toMatch(/actual peak-case cost/);
    expect(text).toMatch(/physical slot 0/);
    // A level guide is not a mandatory walkthrough that reveals the cheapest
    // concrete configuration.
    expect(text).not.toMatch(/cheapest (solution|design) is/i);
    expect(text).not.toMatch(/you must add/i);
  });

  it('states that cache TTL is real retention, not a hidden clamp', () => {
    const text = guideText('live-audience');
    expect(text).toMatch(/actual retention you select/);
    expect(text).toMatch(/Nothing clamps the TTL/);
  });
});

describe('Live Scoreboard help entry', () => {
  it('explains interaction and requirements without naming a winning design', () => {
    const text = guideText('live-scoreboard');

    expect(text).toMatch(/Connect/);
    expect(text).toMatch(/Refresh and Reset/);
    expect(text).toMatch(/up to 5 seconds behind/);
    expect(text).toMatch(/whole 90 s run/);
    expect(text).toMatch(/20–60 s peak/);
    expect(text).toMatch(/lower actual cost ranks first/);
    expect(text).not.toMatch(/cheapest (solution|design) is/i);
    expect(text).not.toMatch(/you must add/i);
  });
});
