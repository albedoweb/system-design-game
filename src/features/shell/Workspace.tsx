import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';

import {
  DEFAULT_LEVEL,
  MAX_INPUT_BYTES,
  validateGraph,
} from '../../domain';
import { useEditorStore } from '../../state/editor-store';
import { isSessionLocked, useSessionStore } from '../../state/session-store';
import { Button } from '../../ui/Button';
import { Modal } from '../../ui/Modal';
import { useMediaQuery } from '../../ui/use-media-query';
import { Briefing } from '../briefing/Briefing';
import { ConnectionDialog } from '../editor/ConnectionDialog';
import { EditorCanvas } from '../editor/EditorCanvas';
import {
  Notice,
  SidePanel,
  WorkspaceLayout,
  WorkspaceToolbar,
} from '../game-ui';
import { MetricsPanel } from '../metrics/MetricsPanel';
import { ComponentPalette } from '../palette/ComponentPalette';
import { Inspector } from '../inspector/Inspector';
import {
  parseLevelStateFile,
  serializeLevelStateFile,
} from '../persistence/import-export';
import { downloadTextFile } from '../persistence/draft-storage';
import { useRunEvidence } from '../simulation/run-evidence';
import { SimulationHeader } from './SimulationHeader';
import { TelemetryResizer } from './TelemetryResizer';
import {
  readTelemetryHeight,
  writeTelemetryHeight,
} from './telemetry-layout';
import './workspace.css';

type LeftTab = 'task' | 'palette';
type ResetMode = 'graph' | null;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

export function Workspace() {
  const level = DEFAULT_LEVEL;
  const graph = useEditorStore((state) => state.graph);
  const selection = useEditorStore((state) => state.selection);
  const past = useEditorStore((state) => state.past);
  const future = useEditorStore((state) => state.future);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const resetGraph = useEditorStore((state) => state.resetGraph);
  const replaceGraph = useEditorStore((state) => state.replaceGraph);
  const removeNode = useEditorStore((state) => state.removeNode);
  const removeEdge = useEditorStore((state) => state.removeEdge);
  const clearSelection = useEditorStore((state) => state.clearSelection);
  const select = useEditorStore((state) => state.select);
  const phase = useSessionStore((state) => state.phase);
  const runResult = useSessionStore((state) => state.result);
  const sessionError = useSessionStore((state) => state.error);
  const notice = useSessionStore((state) => state.notice);

  const evidence = useRunEvidence();
  const compact = useMediaQuery('(max-width: 1320px)');
  const [leftTab, setLeftTab] = useState<LeftTab>('task');
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<'properties' | 'results'>('properties');
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [resetMode, setResetMode] = useState<ResetMode>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<{
    tone: 'success' | 'danger';
    text: string;
  } | null>(null);
  const [telemetryOpen, setTelemetryOpen] = useState(true);
  const [telemetryHeight, setTelemetryHeight] = useState<number | null>(() =>
    readTelemetryHeight(),
  );
  const [telemetryResizing, setTelemetryResizing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const metricsPanelRef = useRef<HTMLElement>(null);

  const canvasEvidence = useMemo(
    () => ({
      mode: evidence.mode,
      stale: evidence.stale,
      diagnosticsByNode: evidence.diagnosticsByNode,
    }),
    [evidence.diagnosticsByNode, evidence.mode, evidence.stale],
  );

  const changeTelemetryOpen = useCallback((open: boolean) => {
    setTelemetryOpen(open);
    if (!open) {
      setTelemetryResizing(false);
    }
  }, []);

  const locked = isSessionLocked(phase);
  const issues = useMemo(() => validateGraph(graph, { mode: 'run' }), [graph]);
  const canUndo = past.length > 0 && !locked;
  const canRedo = future.length > 0 && !locked;

  const handleDeleteSelection = useCallback(() => {    if (!selection) {
      return;
    }
    if (locked) {
      setFlash('The graph is frozen until the run ends.');
      return;
    }
    const result =
      selection.type === 'node'
        ? removeNode(selection.id)
        : removeEdge(selection.id);
    setFlash(result.ok ? null : (result.message ?? 'Could not delete'));
  }, [locked, removeEdge, removeNode, selection]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) {
        return;
      }
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (!locked) {
          if (event.shiftKey) {
            redo();
          } else {
            undo();
          }
        }
        return;
      }
      if (event.key === 'Escape') {
        if (leftOpen || rightOpen) {
          setLeftOpen(false);
          setRightOpen(false);
          return;
        }
        if (selection) {
          clearSelection();
        }
        return;
      }
      if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        selection
      ) {
        event.preventDefault();
        handleDeleteSelection();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    clearSelection,
    handleDeleteSelection,
    leftOpen,
    locked,
    redo,
    rightOpen,
    selection,
    undo,
  ]);

  const handleCanvasSelected = useCallback(() => {
    if (compact) {
      setRightOpen(true);
    }
  }, [compact]);

  const exportGraph = () => {
    const seed = useSessionStore.getState().seed;
    downloadTextFile(
      serializeLevelStateFile(graph, seed),
      `${level.id}-${level.contentVersion}-seed-${seed}.json`,
    );
    setFlash(
      'Saved the graph, settings, positions and seed to a file. Nothing is saved automatically.',
    );
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    setImportMessage(null);
    if (!file) {
      return;
    }
    if (file.size > MAX_INPUT_BYTES) {
      setImportMessage({
        tone: 'danger',
        text: 'The file is larger than 1 MiB — import rejected, the graph was not changed.',
      });
      return;
    }
    try {
      const text = await file.text();
      const result = parseLevelStateFile(text, file.size);
      if (!result.ok) {
        setImportMessage({
          tone: 'danger',
          text: `Open rejected, the graph and seed were not changed. ${result.message}`,
        });
        return;
      }
      replaceGraph(result.graph);
      useSessionStore.getState().reset();
      useSessionStore
        .getState()
        .setSeed(result.seed ?? DEFAULT_LEVEL.defaultSeed);
      setImportMessage({
        tone: 'success',
        text:
          result.format === 'state'
            ? 'Opened the saved graph, settings, positions and seed. Nothing new is saved automatically.'
            : `Opened a graph-only file. The seed was set to the level default (${DEFAULT_LEVEL.defaultSeed}).`,
      });
      setLeftTab('task');
      setLeftOpen(false);
    } catch {
      setImportMessage({
        tone: 'danger',
        text: 'Could not read the file. The graph and seed were not changed.',
      });
    }
  };

  const resetAction = () => {
    if (resetMode === 'graph') {
      resetGraph();
      useSessionStore.getState().reset();
      setFlash(
        'The starting graph and default seed have been restored. The previous run result was cleared.',
      );
    }
    setResetMode(null);
  };

  return (
    <div className="app-shell">
      <SimulationHeader level={level} />

      <div className="app-notices">
        {issues.length > 0 ? (
          <Notice tone="warning" title={`Graph is not ready to run · ${issues.length}`}>
            <ul>
              {issues.slice(0, 3).map((issue, index) => (
                <li key={`${issue.code}-${index}`}>
                  {issue.message}
                  {issue.nodeId ? (
                    <button
                      type="button"
                      onClick={() => select({ type: 'node', id: issue.nodeId! })}
                    >
                      show
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}

        {sessionError ? (
          <Notice tone="danger" title="The run did not start">
            <p>{sessionError}</p>
            <p>
              The current graph remains in this tab. Nothing is saved
              automatically — use Export before reloading if you want to keep
              it. Check the engine environment and try again.
            </p>
          </Notice>
        ) : null}

        {notice && phase === 'stopped' ? (
          <Notice tone="info" title="Run stopped">
            <p>{notice}</p>
          </Notice>
        ) : null}

        {importMessage ? (
          <Notice
            tone={importMessage.tone}
            title={importMessage.tone === 'success' ? 'File opened' : 'Open rejected'}
            onClose={() => setImportMessage(null)}
          >
            <p>{importMessage.text}</p>
          </Notice>
        ) : null}

        {flash ? (
          <Notice tone="info" title="Graph" onClose={() => setFlash(null)}>
            <p>{flash}</p>
          </Notice>
        ) : null}
      </div>

      <WorkspaceLayout
        className="workspace"
        leftOpen={leftOpen}
        rightOpen={rightOpen}
        compact={compact}
        onClosePanels={() => {
          setLeftOpen(false);
          setRightOpen(false);
        }}
        splitRef={splitRef}
        leftPanel={
          <SidePanel
            side="left"
            label="Task and components"
            open={leftOpen}
            onClose={() => setLeftOpen(false)}
            tabs={[
              { id: 'task', label: 'Task' },
              { id: 'palette', label: 'Components' },
            ]}
            activeTab={leftTab}
            onTabChange={(id) => setLeftTab(id as LeftTab)}
          >
            {leftTab === 'task' ? (
              <Briefing level={level} />
            ) : (
              <ComponentPalette
                locked={locked}
                onOpenConnect={() => setConnectionOpen(true)}
              />
            )}
          </SidePanel>
        }
        toolbar={
          <WorkspaceToolbar
            leftOpen={leftOpen}
            rightOpen={rightOpen}
            onToggleLeft={() => {
              setLeftOpen((value) => !value);
              setRightOpen(false);
            }}
            onToggleRight={() => {
              setRightOpen((value) => !value);
              setLeftOpen(false);
              setInspectorTab('properties');
            }}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
            locked={locked}
            onConnect={() => setConnectionOpen(true)}
            onExport={exportGraph}
            onImport={() => fileInputRef.current?.click()}
            onReset={() => setResetMode('graph')}
            exportTitle="Save the graph, settings, positions and seed to a file. Nothing is saved automatically."
            rightActions={
              runResult ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    clearSelection();
                    setInspectorTab('results');
                    setRightOpen(true);
                    setLeftOpen(false);
                  }}
                >
                  View results
                </Button>
              ) : null
            }
          />
        }
        canvas={
          <EditorCanvas
            graph={graph}
            selection={selection}
            locked={locked}
            snapshot={evidence.snapshot}
            evidence={canvasEvidence}
            suppressAutoFit={telemetryResizing}
            onSelected={handleCanvasSelected}
          />
        }
        resizer={
          telemetryOpen ? (
            <TelemetryResizer
              containerRef={splitRef}
              panelRef={metricsPanelRef}
              height={telemetryHeight}
              onChange={setTelemetryHeight}
              onCommit={(value) => writeTelemetryHeight(value)}
              onResizeStart={() => setTelemetryResizing(true)}
              onResizeEnd={() => setTelemetryResizing(false)}
            />
          ) : null
        }
        telemetry={
          <MetricsPanel
            level={level}
            open={telemetryOpen}
            onOpenChange={changeTelemetryOpen}
            height={telemetryHeight}
            panelRef={metricsPanelRef}
          />
        }
        rightPanel={
          <SidePanel
            side="right"
            label="Inspector"
            open={rightOpen}
            onClose={() => setRightOpen(false)}
          >
            <Inspector level={level} tab={inspectorTab} setTab={setInspectorTab} />
          </SidePanel>
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="visually-hidden"
        onChange={handleFile}
        aria-label="Open saved graph file"
      />

      {connectionOpen ? (
        <ConnectionDialog
          graph={graph}
          locked={locked}
          onClose={() => setConnectionOpen(false)}
        />
      ) : null}

      {resetMode ? (
        <Modal
          title="Restore the starting graph?"
          onClose={() => setResetMode(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setResetMode(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={resetAction}>
                Reset graph
              </Button>
            </>
          }
        >
          <p>
            The current graph and edit history will be replaced by the level’s
            starting graph and the default seed. The previous run result is
            cleared, so the level starts ready to run. Nothing is saved
            automatically; use Export before resetting if you want a file.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
