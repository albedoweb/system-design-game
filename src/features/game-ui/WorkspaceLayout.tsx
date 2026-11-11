import type { ReactNode, RefObject } from 'react';

import './game-ui.css';

export type WorkspaceLayoutVariant = 'fixed' | 'collapsible';

export interface WorkspaceLayoutProps {
  /** Level root class, kept for level-specific columns and breakpoints. */
  className?: string;
  variant?: WorkspaceLayoutVariant;
  leftOpen: boolean;
  rightOpen: boolean;
  compact: boolean;
  onClosePanels: () => void;
  leftPanel: ReactNode;
  rightPanel: ReactNode;
  toolbar: ReactNode;
  canvas: ReactNode;
  /** Divider between canvas and telemetry (the shared TelemetryResizer). */
  resizer?: ReactNode;
  telemetry?: ReactNode;
  splitRef?: RefObject<HTMLDivElement | null>;
  backdropLabel?: string;
  /** Inspectors may stay non-modal so the canvas remains selectable. */
  modalInspector?: boolean;
}

/**
 * The shared graph workspace: left panel, toolbar, canvas, telemetry split and
 * inspector. Every piece is a slot; open state, panel tabs, run state and
 * persistence stay owned by the level. The level class adds only its own grid
 * widths and narrow-screen overrides.
 */
export function WorkspaceLayout({
  className,
  variant = 'fixed',
  leftOpen,
  rightOpen,
  compact,
  onClosePanels,
  leftPanel,
  rightPanel,
  toolbar,
  canvas,
  resizer,
  telemetry,
  splitRef,
  backdropLabel = 'Close panels',
  modalInspector = true,
}: WorkspaceLayoutProps) {
  return (
    <main
      className={[
        'game-workspace',
        `game-workspace--${variant}`,
        className,
        leftOpen ? 'is-left-open' : '',
        rightOpen ? 'is-right-open' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {leftPanel}

      <section className="game-workspace__main">
        {toolbar}
        <div className="game-split" ref={splitRef}>
          <div className="game-canvas-area">
            {canvas}
          </div>
          {resizer}
          {telemetry}
        </div>
      </section>

      {rightPanel}

      {compact && (leftOpen || (rightOpen && modalInspector)) ? (
        <button
          type="button"
          className="game-workspace__backdrop"
          aria-label={backdropLabel}
          onClick={onClosePanels}
        />
      ) : null}
    </main>
  );
}
