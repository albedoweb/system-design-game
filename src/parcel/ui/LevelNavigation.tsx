import { Image, Package, Radio, Snowflake, Trophy } from 'lucide-react';

import { LEVEL_ROUTES, type LevelRoute } from './level-route';

const LEVEL_ICONS = {
  'live-audience': Radio,
  'live-scoreboard': Trophy,
  'cold-cache': Snowflake,
  'parcel-pulse': Package,
  'image-atlas': Image,
} as const;

const LEVEL_CODES: Record<LevelRoute, string> = {
  'live-audience': 'L01',
  'live-scoreboard': 'L02',
  'cold-cache': 'L03',
  'parcel-pulse': 'L04',
  'image-atlas': 'L05',
};

export function LevelNavigation({ route }: { route: LevelRoute }) {
  return (
    <nav className="level-nav" aria-label="Levels">
      <div className="level-nav__brand" aria-hidden="true">
        System Design Game
      </div>
      <ul className="level-nav__list">
        {LEVEL_ROUTES.map((item) => {
          const active = item.id === route;
          const Icon = LEVEL_ICONS[item.id];
          return (
            <li key={item.id}>
              <a
                className={`level-nav__link${active ? ' is-active' : ''}`}
                href={item.hash}
                aria-current={active ? 'page' : undefined}
                title={item.subtitle}
              >
                <Icon size={15} aria-hidden="true" />
                <span>{item.title}</span>
                <small>{LEVEL_CODES[item.id]}</small>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
