import type { ReactNode } from 'react';

import './game-ui.css';

export type NoticeTone = 'info' | 'warning' | 'danger' | 'success';

export interface NoticeProps {
  tone?: NoticeTone;
  title: ReactNode;
  children?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  className?: string;
}

/**
 * Level-agnostic notice banner. Uses the shared `.notice` presentation that
 * already exists in the application shell, so every level shows validation,
 * import and run messages with the same visual weight and semantics.
 */
export function Notice({
  tone = 'info',
  title,
  children,
  onClose,
  closeLabel = 'Dismiss notification',
  className,
}: NoticeProps) {
  return (
    <div
      className={['notice', 'game-notice', `notice--${tone}`, className]
        .filter(Boolean)
        .join(' ')}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      <div>
        <strong>{title}</strong>
        {children ? <div className="notice__body">{children}</div> : null}
      </div>
      {onClose ? (
        <button type="button" onClick={onClose} aria-label={closeLabel}>
          ✕
        </button>
      ) : null}
    </div>
  );
}
