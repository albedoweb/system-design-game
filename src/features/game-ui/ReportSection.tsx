import type { ReactNode } from 'react';

import './game-ui.css';

export interface ReportSectionProps {
  title?: ReactNode;
  /** Short explanation shown above the section content. */
  description?: ReactNode;
  /** Caveat or scope note shown below the section content. */
  note?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * Shared report section heading and spacing. Optional sections are omitted by
 * the caller instead of being rendered with zero values.
 */
export function ReportSection({
  title,
  description,
  note,
  actions,
  children,
  className,
}: ReportSectionProps) {
  return (
    <section className={['game-report-section', className].filter(Boolean).join(' ')}>
      {title || actions ? (
        <div className="game-report-section__head">
          {title ? <h3 className="game-report-section__title">{title}</h3> : null}
          {actions ? <div className="game-report-section__actions">{actions}</div> : null}
        </div>
      ) : null}
      {description ? (
        <p className="game-report-section__note">{description}</p>
      ) : null}
      {children}
      {note ? <p className="game-report-section__note">{note}</p> : null}
    </section>
  );
}
