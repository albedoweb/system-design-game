import { describe, expect, it } from 'vitest';

import { scoreboardLinkRole } from '../index';
import {
  scoreboardLinkColor,
  scoreboardLinkLabel,
  scoreboardLinkLongLabel,
} from './scoreboard-meta';

describe('Live Scoreboard dependency vocabulary', () => {
  it('labels the Application -> SQL path as a primary read/write path', () => {
    const role = scoreboardLinkRole('app', 'sql');
    expect(role).not.toBeNull();
    expect(scoreboardLinkLabel(role)).toBe('read / write');
    expect(scoreboardLinkLongLabel(role)).toMatch(
      /vote writes and direct leaderboard reads/,
    );
    expect(scoreboardLinkLabel(role)).not.toMatch(/^writes$/);
  });

  it('keeps distinct labels and semantic colours for the other pairs', () => {
    const traffic = scoreboardLinkRole('users', 'app');
    const reads = scoreboardLinkRole('app', 'cache');
    const fill = scoreboardLinkRole('cache', 'sql');
    expect(scoreboardLinkLabel(traffic)).toBe('traffic');
    expect(scoreboardLinkLabel(reads)).toBe('reads');
    expect(scoreboardLinkLabel(fill)).toBe('fill');
    expect(new Set([
      scoreboardLinkColor(traffic),
      scoreboardLinkColor(reads),
      scoreboardLinkColor(fill),
    ]).size).toBe(3);
    expect(scoreboardLinkRole('users', 'sql')).toBeNull();
  });
});
