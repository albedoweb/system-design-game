import '@xyflow/react/dist/style.css';

import { ShoppingCart } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';

import { CartHeader } from '../cart/ui/CartHeader';
import '../ui/base.css';

import './styles.css';
import './level-navigation.css';
import '../cart/ui/cart-theme.css';

const LegacyLevels = lazy(() => import('./LegacyLevels'));

type LegacyRoute = 'live-audience' | 'live-scoreboard' | 'cold-cache' | 'parcel-pulse' | 'image-atlas';
type AppRoute = LegacyRoute | 'global-cart';

// Only these exact hashes open legacy levels; anything else shows Global Cart.
const LEGACY_HASH_ROUTES = new Map<string, LegacyRoute>([
  ['#live-audience', 'live-audience'],
  ['#live-scoreboard', 'live-scoreboard'],
  ['#cold-cache', 'cold-cache'],
  ['#parcel-pulse', 'parcel-pulse'],
  ['#image-atlas', 'image-atlas'],
]);

const CART_TITLE = 'Global Cart';
const CART_DESCRIPTION =
  'Global Cart — design a shopping cart service for three regions and test it under simulated load.';

function setMetaDescription(content: string) {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'description';
    document.head.append(meta);
  }
  meta.content = content;
}

function currentRoute(): AppRoute {
  if (typeof window === 'undefined') {
    return 'global-cart';
  }
  return LEGACY_HASH_ROUTES.get(window.location.hash.toLowerCase()) ?? 'global-cart';
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(currentRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (route !== 'global-cart') {
      delete document.documentElement.dataset.level;
      return;
    }
    document.documentElement.dataset.level = 'global-cart';
    document.title = `${CART_TITLE} — System Design Game`;
    document.documentElement.lang = 'en';
    setMetaDescription(CART_DESCRIPTION);
  }, [route]);

  return (
    <div className="app-frame">
      <div className="app-topbar">
        <div className="app-brand">
          <span className="app-brand__mark" aria-hidden="true">
            <ShoppingCart size={15} strokeWidth={2.2} />
          </span>
          System Design Game
        </div>
      </div>
      <div className="level-host">
        {route === 'global-cart' ? (
          <CartHeader />
        ) : (
          <Suspense fallback={<p className="app-loading" role="status">Loading level…</p>}>
            <LegacyLevels route={route} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
