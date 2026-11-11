export type LevelRoute =
  | 'live-audience'
  | 'live-scoreboard'
  | 'cold-cache'
  | 'parcel-pulse'
  | 'image-atlas';

export interface LevelRouteInfo {
  id: LevelRoute;
  hash: string;
  title: string;
  subtitle: string;
}

/**
 * Live Audience is the first advertised level. The existing levels keep their
 * stable hashes: `/` and `#cold-cache` still open Cold Cache for old direct
 * links, while `#live-scoreboard` stays playable.
 */
export const LEVEL_ROUTES: readonly LevelRouteInfo[] = [
  {
    id: 'live-audience',
    hash: '#live-audience',
    title: 'Live Audience',
    subtitle: 'Exact 15-minute audience rankings under a live peak',
  },
  {
    id: 'live-scoreboard',
    hash: '#live-scoreboard',
    title: 'Live Scoreboard',
    subtitle: 'One shared ranking under live vote changes',
  },
  {
    id: 'cold-cache',
    hash: '#cold-cache',
    title: 'Cold Cache',
    subtitle: 'Shared read/write traffic and a cache flush',
  },
  {
    id: 'parcel-pulse',
    hash: '#parcel-pulse',
    title: 'Parcel Pulse',
    subtitle: 'Tracking, history, ingest and warehouse reports',
  },
  {
    id: 'image-atlas',
    hash: '#image-atlas',
    title: 'Image Atlas',
    subtitle: 'Uploads, search and detail across three regions',
  },
];

export function readLevelRoute(hash: string): LevelRoute {
  const normalized = hash.replace(/^#/, '').toLowerCase();
  if (normalized === 'live-audience') {
    return 'live-audience';
  }
  if (normalized === 'live-scoreboard') {
    return 'live-scoreboard';
  }
  if (normalized === 'parcel-pulse') {
    return 'parcel-pulse';
  }
  if (normalized === 'image-atlas') {
    return 'image-atlas';
  }
  // Backward compatibility: root, empty and unknown hashes stay on Cold Cache.
  return 'cold-cache';
}
