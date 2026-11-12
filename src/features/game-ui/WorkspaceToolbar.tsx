import {
  Download,
  Link2,
  PanelLeft,
  PanelRight,
  Redo2,
  RotateCcw,
  Share2,
  Undo2,
  Upload,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '../../ui/Button';
import './game-ui.css';

export interface WorkspaceToolbarProps {
  /** Controlled visibility of the two side panels, used by the narrow layout. */
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  locked: boolean;
  onConnect: () => void;
  onExport: () => void;
  /** Optional link action rendered after Export (only the Cart level uses it). */
  onCopyLink?: () => void;
  onImport: () => void;
  onReset: () => void;
  /** Level-specific graph actions rendered after Connect (e.g. region layout). */
  leftActions?: ReactNode;
  /** Panel shortcuts placed immediately after Task. */
  taskActions?: ReactNode;
  /** Level-specific report actions rendered after Properties (e.g. Issues). */
  rightActions?: ReactNode;
  taskLabel?: string;
  propertiesLabel?: string;
  connectLabel?: string;
  exportTitle?: string;
  importTitle?: string;
  /**
   * `compact-only` keeps panel buttons hidden until the level's narrow
   * breakpoint; `always` keeps them visible in collapsible-panel layouts.
   */
  panelToggles?: 'compact-only' | 'always';
  toolbarLabel?: string;
  className?: string;
}

/**
 * The graph action bar shared by every level: panel toggles, undo/redo,
 * connect and explicit file/reset operations. State and callbacks stay owned
 * by the level store; this component only renders the controlled controls.
 */
export function WorkspaceToolbar({
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  locked,
  onConnect,
  onExport,
  onCopyLink,
  onImport,
  onReset,
  leftActions,
  taskActions,
  rightActions,
  taskLabel = 'Task',
  propertiesLabel = 'Properties',
  connectLabel = 'Connect',
  exportTitle = 'Save the graph, positions and seed to a file. Nothing is saved automatically.',
  importTitle = 'Open a saved graph state file, or an older graph-only JSON file.',
  panelToggles = 'compact-only',
  toolbarLabel = 'Graph actions',
  className,
}: WorkspaceToolbarProps) {
  return (
    <div
      className={[
        'game-toolbar',
        panelToggles === 'always' ? 'game-toolbar--toggles-always' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      role="toolbar"
      aria-label={toolbarLabel}
    >
      <div className="game-toolbar__group">
        <Button
          variant="ghost"
          size="sm"
          className="game-toolbar__panel-toggle"
          icon={<PanelLeft size={15} />}
          aria-expanded={leftOpen}
          onClick={onToggleLeft}
        >
          {taskLabel}
        </Button>
        {taskActions}
        <Button
          variant="ghost"
          size="sm"
          icon={<Undo2 size={15} />}
          disabled={!canUndo}
          title="Undo (Ctrl/Cmd+Z)"
          aria-label="Undo"
          onClick={onUndo}
        />
        <Button
          variant="ghost"
          size="sm"
          icon={<Redo2 size={15} />}
          disabled={!canRedo}
          title="Redo (Ctrl/Cmd+Shift+Z)"
          aria-label="Redo"
          onClick={onRedo}
        />
        <Button
          variant="secondary"
          size="sm"
          icon={<Link2 size={15} />}
          disabled={locked}
          onClick={onConnect}
        >
          {connectLabel}
        </Button>
        {leftActions}
      </div>

      <div className="game-toolbar__group">
        <Button
          variant="ghost"
          size="sm"
          icon={<Download size={15} />}
          title={exportTitle}
          onClick={onExport}
        >
          Export
        </Button>
        {onCopyLink ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<Share2 size={15} />}
            title="Copy a link that opens this design. Nothing is saved automatically."
            onClick={onCopyLink}
          >
            Copy link
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          icon={<Upload size={15} />}
          title={importTitle}
          disabled={locked}
          onClick={onImport}
        >
          Import
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<RotateCcw size={15} />}
          disabled={locked}
          onClick={onReset}
        >
          Reset
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="game-toolbar__panel-toggle"
          icon={<PanelRight size={15} />}
          aria-expanded={rightOpen}
          onClick={onToggleRight}
        >
          {propertiesLabel}
        </Button>
        {rightActions}
      </div>
    </div>
  );
}
