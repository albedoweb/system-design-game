import { ChevronDown } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';

import './game-ui.css';

export interface TelemetryPanelProps {
  title: ReactNode;
  summary?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  height?: number | null;
  panelRef?: RefObject<HTMLElement | null>;
  bodyId: string;
  ariaLabel: string;
  className?: string;
  children: ReactNode;
}

/**
 * Collapsible telemetry/report panel frame shared by the result views. The
 * level still owns the open state (and persists only its height), while the
 * toggle, aria wiring and resizable sizing stay identical between levels.
 */
export function TelemetryPanel({
  title,
  summary,
  open,
  onOpenChange,
  height = null,
  panelRef,
  bodyId,
  ariaLabel,
  className,
  children,
}: TelemetryPanelProps) {
  const sized = open && height !== null;
  return (
    <section
      ref={panelRef}
      className={[
        'game-telemetry',
        open ? 'is-open' : '',
        height !== null ? 'has-custom-height' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={sized ? { height: `${height}px` } : undefined}
      aria-label={ariaLabel}
    >
      <button
        type="button"
        className="game-telemetry__toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => onOpenChange(!open)}
      >
        <span className="game-telemetry__toggle-title">{title}</span>
        {summary ? <span className="game-telemetry__summary">{summary}</span> : null}
        <ChevronDown
          size={17}
          aria-hidden="true"
          className={open ? 'is-rotated' : ''}
        />
      </button>

      {open ? (
        <div className="game-telemetry__body" id={bodyId}>
          {children}
        </div>
      ) : null}
    </section>
  );
}
