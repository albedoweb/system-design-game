import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';

import { PARCEL_LEVEL } from '../level';
import { validateParcelGraph } from '../graph';
import type { ParcelIssue } from '../contracts';
import { useMediaQuery } from '../../ui/use-media-query';
import { Button } from '../../ui/Button';
import { Modal } from '../../ui/Modal';
import {
  Notice,
  SidePanel,
  WorkspaceLayout,
  WorkspaceToolbar,
} from '../../features/game-ui';
import { TelemetryResizer } from '../../features/shell/TelemetryResizer';
import { ParcelBriefing } from './ParcelBriefing';
import { ParcelCanvas, type ParcelConnectRequest } from './ParcelCanvas';
import { ParcelConnectDialog } from './ParcelConnectDialog';
import { ParcelHeader } from './ParcelHeader';
import { ParcelInspector } from './ParcelInspector';
import { ParcelPalette } from './ParcelPalette';
import { ParcelResultsPanel } from './ParcelResultsPanel';
import {
  PARCEL_MAX_IMPORT_BYTES,
  downloadParcelText,
  parseParcelState,
  serializeParcelState,
} from './parcel-persistence';
import {
  uniqueParcelIssues,
} from './parcel-diagnostics';
import { createParcelRunController } from './parcel-run-controller';
import {
  PARCEL_DEFAULT_TELEMETRY_HEIGHT,
  readParcelTelemetryHeight,
  writeParcelTelemetryHeight,
} from './parcel-telemetry';
import { useParcelStore } from './parcel-store';
import './parcel.css';

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

function isInsideDialog(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="dialog"]') !== null;
}

export function ParcelWorkspace() {
  const graph = useParcelStore((state) => state.graph);
  const selection = useParcelStore((state) => state.selection);
  const past = useParcelStore((state) => state.past);
  const future = useParcelStore((state) => state.future);
  const runPhase = useParcelStore((state) => state.runPhase);
  const seed = useParcelStore((state) => state.seed);
  const undo = useParcelStore((state) => state.undo);
  const redo = useParcelStore((state) => state.redo);
  const resetGraph = useParcelStore((state) => state.resetGraph);
  const openState = useParcelStore((state) => state.openState);
  const removeNode = useParcelStore((state) => state.removeNode);
  const removeEdge = useParcelStore((state) => state.removeEdge);
  const clearSelection = useParcelStore((state) => state.clearSelection);
  const select = useParcelStore((state) => state.select);

  const compact = useMediaQuery('(max-width: 1360px)');
  const [controller] = useState(() => createParcelRunController());
  const [leftTab, setLeftTab] = useState<LeftTab>('task');
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<'properties' | 'issues'>('properties');
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectInitial, setConnectInitial] = useState<ParcelConnectRequest | undefined>();
  const [resetMode, setResetMode] = useState<ResetMode>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<{
    tone: 'success' | 'danger';
    text: string;
  } | null>(null);
  const [telemetryOpen, setTelemetryOpen] = useState(() => {
    const phase = useParcelStore.getState().runPhase;
    return phase !== 'idle';
  });
  const [telemetryHeight, setTelemetryHeight] = useState<number | null>(
    () => readParcelTelemetryHeight() ?? PARCEL_DEFAULT_TELEMETRY_HEIGHT,
  );
  const [telemetryResizing, setTelemetryResizing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const resultsPanelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    return () => {
      controller.dispose();
    };
  }, [controller]);

  const locked = runPhase === 'running' || runPhase === 'stopping';
  const issues = useMemo(
    () => uniqueParcelIssues(validateParcelGraph(graph, { mode: 'run' })),
    [graph],
  );
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const canUndo = past.length > 0 && !locked;
  const canRedo = future.length > 0 && !locked;

  const focusIssue = useCallback(
    (issue: ParcelIssue) => {
      if (issue.nodeId) {
        select({ type: 'node', id: issue.nodeId });
      } else if (issue.edgeId) {
        select({ type: 'edge', id: issue.edgeId });
      }
      if (compact) {
        setRightOpen(true);
        setLeftOpen(false);
      }
      setInspectorTab('issues');
    },
    [compact, select],
  );

  const handleDeleteSelection = useCallback(() => {
    if (!selection) {
      return;
    }
    if (locked) {
      setFlash('The graph is read-only while the evaluation runs.');
      return;
    }
    const result =
      selection.type === 'node'
        ? removeNode(selection.id)
        : removeEdge(selection.id);
    setFlash(result.ok ? null : (result.message ?? 'Could not delete the selection.'));
  }, [locked, removeEdge, removeNode, selection]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) {
        return;
      }
      // A dialog owns its keyboard surface: Escape and button activation stay
      // with the shared Modal, while graph Delete/Backspace and undo/redo must
      // not mutate the graph behind it.
      if (connectOpen || resetMode !== null || isInsideDialog(event.target)) {
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
      if ((event.key === 'Delete' || event.key === 'Backspace') && selection) {
        event.preventDefault();
        handleDeleteSelection();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    clearSelection,
    connectOpen,
    handleDeleteSelection,
    leftOpen,
    locked,
    redo,
    resetMode,
    rightOpen,
    selection,
    undo,
  ]);

  const changeTelemetryOpen = useCallback((open: boolean) => {
    setTelemetryOpen(open);
    if (!open) {
      setTelemetryResizing(false);
    }
  }, []);

  const exportGraph = () => {
    downloadParcelText(
      serializeParcelState(graph, seed),
      `${PARCEL_LEVEL.id}-${PARCEL_LEVEL.contentVersion}-seed-${seed}.json`,
    );
    setFlash(
      'Saved the graph, node settings, positions and seed to a file. Nothing is saved automatically.',
    );
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    setImportMessage(null);
    if (!file) {
      return;
    }
    if (file.size > PARCEL_MAX_IMPORT_BYTES) {
      setImportMessage({
        tone: 'danger',
        text: 'The file is larger than 1 MiB — import rejected, the graph was not changed.',
      });
      return;
    }
    try {
      const text = await file.text();
      const result = parseParcelState(text, file.size);
      if (!result.ok) {
        setImportMessage({
          tone: 'danger',
          text: `Open rejected, the graph was not changed. ${result.message}`,
        });
        return;
      }
      const openedSeed = result.seed ?? PARCEL_LEVEL.defaultSeed;
      openState(result.graph, openedSeed);
      setImportMessage({
        tone: 'success',
        text:
          result.format === 'state'
            ? 'Opened the saved graph, positions and seed. Nothing new is saved automatically.'
            : `Opened a graph-only file. The seed was set to the level default (${PARCEL_LEVEL.defaultSeed}).`,
      });
      setLeftTab('task');
      setLeftOpen(false);
    } catch {
      setImportMessage({
        tone: 'danger',
        text: 'Could not read the file. The graph was not changed.',
      });
    }
  };

  const resetAction = () => {
    if (resetMode === 'graph') {
      resetGraph();
      setFlash(
        'The Parcel starter and default seed have been restored. The previous run result was cleared.',
      );
    }
    setResetMode(null);
  };

  const runEvaluation = () => {
    controller.start({
      graph: useParcelStore.getState().graph,
      seed: useParcelStore.getState().seed,
    });
    setTelemetryOpen(true);
    const state = useParcelStore.getState();
    if (state.runPhase === 'blocked') {
      setInspectorTab('issues');
      setRightOpen(true);
      setLeftOpen(false);
    }
  };

  const stopEvaluation = () => {
    controller.cancel();
    setTelemetryOpen(true);
  };

  return (
    <div className="parcel-shell">
      <ParcelHeader onRun={runEvaluation} onStop={stopEvaluation} />

      <div className="parcel-notices">
        {issues.length > 0 ? (
          <Notice
            tone={errorCount > 0 ? 'danger' : 'warning'}
            title={
              errorCount > 0
                ? `Run will be blocked by ${errorCount} error${errorCount === 1 ? '' : 's'}`
                : `${issues.length} warning${issues.length === 1 ? '' : 's'} — the graph can run`
            }
          >
            <ul>
              {issues.slice(0, 4).map((issue, index) => (
                <li key={`${issue.code}-${index}`}>
                  {issue.message}
                  {issue.nodeId || issue.edgeId ? (
                    <button type="button" onClick={() => focusIssue(issue)}>
                      show
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
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
        className="parcel-workspace"
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
              <ParcelBriefing />
            ) : (
              <ParcelPalette
                locked={locked}
                onOpenConnect={() => {
                  setConnectInitial(undefined);
                  setConnectOpen(true);
                }}
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
            onConnect={() => {
              setConnectInitial(undefined);
              setConnectOpen(true);
            }}
            onExport={exportGraph}
            onImport={() => fileInputRef.current?.click()}
            onReset={() => setResetMode('graph')}
            exportTitle="Save the graph, positions and seed to a file. Nothing is saved automatically."
            importTitle="Open a saved graph state file, or an older graph-only JSON file."
            rightActions={
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={rightOpen && inspectorTab === 'issues'}
                onClick={() => {
                  setInspectorTab('issues');
                  setRightOpen(true);
                  setLeftOpen(false);
                }}
              >
                Issues
              </Button>
            }
          />
        }
        canvas={
          <ParcelCanvas
            suppressAutoFit={telemetryResizing}
            onSelected={() => {
              if (compact) {
                setRightOpen(true);
                setLeftOpen(false);
                setInspectorTab('properties');
              }
            }}
            onRequestConnect={(request) => {
              setConnectInitial(request);
              setConnectOpen(true);
            }}
          />
        }
        resizer={
          telemetryOpen ? (
            <TelemetryResizer
              containerRef={splitRef}
              panelRef={resultsPanelRef}
              height={telemetryHeight}
              onChange={setTelemetryHeight}
              onCommit={(value) => writeParcelTelemetryHeight(value)}
              onResizeStart={() => setTelemetryResizing(true)}
              onResizeEnd={() => setTelemetryResizing(false)}
            />
          ) : null
        }
        telemetry={
          <ParcelResultsPanel
            open={telemetryOpen}
            onOpenChange={changeTelemetryOpen}
            height={telemetryHeight}
            panelRef={resultsPanelRef}
          />
        }
        rightPanel={
          <SidePanel
            side="right"
            label="Inspector"
            open={rightOpen}
            onClose={() => setRightOpen(false)}
          >
            <ParcelInspector tab={inspectorTab} setTab={setInspectorTab} />
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

      {connectOpen ? (
        <ParcelConnectDialog
          graph={graph}
          locked={locked}
          initial={connectInitial}
          onClose={() => {
            setConnectOpen(false);
            setConnectInitial(undefined);
          }}
        />
      ) : null}

      {resetMode ? (
        <Modal
          title="Restore the Parcel starter?"
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
            The current graph and edit history will be replaced by the level
            starter and the default seed. The previous run result is cleared, so
            the level starts ready to run. Nothing is saved automatically; use
            Export before resetting if you want a file.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
