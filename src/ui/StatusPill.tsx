import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export function StatusPill({
  tone = 'neutral',
  children,
  icon,
}: {
  tone?: Tone;
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <span className={`ui-pill ui-pill--${tone}`}>
      {icon ? (
        <span className="ui-pill__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}
