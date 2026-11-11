import { useEffect, useState } from 'react';

import { formatDecimal } from '../../ui/format';

/** Count-up duration in milliseconds (ease-out). */
const TICK_MS = 400;

/**
 * True when the number should appear at its final value at once: no
 * matchMedia (jsdom), no requestAnimationFrame, or reduced motion requested.
 */
function skipAnimation(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  if (typeof window.requestAnimationFrame !== 'function') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Counts up from 0 to `value` with ease-out, as a visual layer only. The
 * element's text is always the final formatDecimal(value, decimals): the
 * moving digits are drawn by a pseudo-element from `data-display`, so a screen
 * reader, a copy-paste or a test never sees an intermediate number.
 */
export function CartNumberTicker({ value, decimals = 2 }: { value: number; decimals?: number }) {
  // `frame` holds the animated number for the target it was computed for.
  const [frame, setFrame] = useState<{ target: number; shown: number }>(() => ({ target: value, shown: value }));

  useEffect(() => {
    if (skipAnimation()) return undefined;
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / TICK_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      setFrame({ target: value, shown: t >= 1 ? value : value * eased });
      if (t < 1) raf = window.requestAnimationFrame(step);
    };
    raf = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(raf);
  }, [value]);

  const final = formatDecimal(value, decimals);
  const shown = skipAnimation() ? value : frame.target === value ? frame.shown : 0;
  const animating = shown !== value;
  return (
    <span
      className={animating ? 'cart-number is-ticking' : 'cart-number'}
      data-display={animating ? formatDecimal(shown, decimals) : undefined}
    >
      {final}
    </span>
  );
}
