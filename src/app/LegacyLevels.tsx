import { useEffect } from 'react';

import { AUDIENCE_LEVEL } from '../audience';
import { AudienceWorkspace } from '../audience/ui/AudienceWorkspace';
import { DEFAULT_LEVEL } from '../domain';
import { HelpDialog } from '../features/help/HelpDialog';
import { SimulationProvider } from '../features/simulation/SimulationProvider';
import { Workspace } from '../features/shell/Workspace';
import { IMAGE_LEVEL } from '../images/level';
import { ImageWorkspace } from '../images/ui/ImageWorkspace';
import { PARCEL_LEVEL } from '../parcel/level';
import type { LevelRoute } from '../parcel/ui/level-route';
import { ParcelWorkspace } from '../parcel/ui/ParcelWorkspace';
import { SCOREBOARD_LEVEL } from '../scoreboard';
import { ScoreboardWorkspace } from '../scoreboard/ui/ScoreboardWorkspace';

// Legacy levels are reachable only by their direct hashes. This module is
// loaded lazily from App so their code stays out of the main bundle.
function levelFor(route: LevelRoute) {
  if (route === 'live-audience') return AUDIENCE_LEVEL;
  if (route === 'live-scoreboard') return SCOREBOARD_LEVEL;
  if (route === 'parcel-pulse') return PARCEL_LEVEL;
  if (route === 'image-atlas') return IMAGE_LEVEL;
  return DEFAULT_LEVEL;
}

export default function LegacyLevels({ route }: { route: LevelRoute }) {
  useEffect(() => {
    const level = levelFor(route);
    document.title = `${level.title} — System Design Game`;
    document.documentElement.lang = 'en';
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'description';
      document.head.append(meta);
    }
    meta.content = `${level.title} — a browser-based system design editor and simulation.`;
  }, [route]);

  return (
    <>
      <HelpDialog key={route} currentLevel={route} />
      {route === 'live-audience' ? (
        <AudienceWorkspace />
      ) : route === 'live-scoreboard' ? (
        <ScoreboardWorkspace />
      ) : route === 'parcel-pulse' ? (
        <ParcelWorkspace />
      ) : route === 'image-atlas' ? (
        <ImageWorkspace />
      ) : (
        <SimulationProvider>
          <Workspace />
        </SimulationProvider>
      )}
    </>
  );
}
