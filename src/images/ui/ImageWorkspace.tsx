import { Grid2x2 } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';

import { IMAGE_CONTENT_VERSION, IMAGE_LEVEL_ID } from '../contracts';
import { IMAGE_LEVEL } from '../level';
import { validateImageGraph } from '../graph';
import type { ImageIssue } from '../contracts';
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
import { ImageBriefing } from './ImageBriefing';
import { ImageCanvas, type ImageConnectRequest } from './ImageCanvas';
import { ImageConnectDialog } from './ImageConnectDialog';
import { ImageHeader } from './ImageHeader';
import { ImageInspector } from './ImageInspector';
import { ImagePalette } from './ImagePalette';
import { ImageResultsPanel } from './ImageResultsPanel';
import {
  IMAGE_MAX_IMPORT_BYTES,
  downloadImageText,
  parseImageState,
  serializeImageState,
} from './image-persistence';
import { imageUniqueIssues } from './image-diagnostics';
import { createImageRunController } from './image-run-controller';
import {
  IMAGE_DEFAULT_TELEMETRY_HEIGHT,
  readImageTelemetryHeight,
  writeImageTelemetryHeight,
} from './image-telemetry';
import { useImageStore } from './image-store';
import './image.css';

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

export function ImageWorkspace() {
  const graph = useImageStore((state) => state.graph);
  const selection = useImageStore((state) => state.selection);
  const past = useImageStore((state) => state.past);
  const future = useImageStore((state) => state.future);
  const runPhase = useImageStore((state) => state.runPhase);
  const undo = useImageStore((state) => state.undo);
  const redo = useImageStore((state) => state.redo);
  const resetGraph = useImageStore((state) => state.resetGraph);
  const openState = useImageStore((state) => state.openState);
  const arrangeByRegion = useImageStore((state) => state.arrangeByRegion);
  const removeNode = useImageStore((state) => state.removeNode);
  const removeEdge = useImageStore((state) => state.removeEdge);
  const clearSelection = useImageStore((state) => state.clearSelection);
  const select = useImageStore((state) => state.select);

  const compact = useMediaQuery('(max-width: 1360px)');
  const [controller] = useState(() => createImageRunController());
  const [leftTab, setLeftTab] = useState<LeftTab>('task');
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<'properties' | 'issues'>(
    'properties',
  );
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectInitial, setConnectInitial] = useState<
    ImageConnectRequest | undefined
  >();
  const [resetMode, setResetMode] = useState<ResetMode>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<{
    tone: 'success' | 'danger';
    text: string;
  } | null>(null);
  const [telemetryOpen, setTelemetryOpen] = useState(() => {
    const phase = useImageStore.getState().runPhase;
    return phase !== 'idle';
  });
  const [telemetryHeight, setTelemetryHeight] = useState<number | null>(
    () => readImageTelemetryHeight() ?? IMAGE_DEFAULT_TELEMETRY_HEIGHT,
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
    () => imageUniqueIssues(validateImageGraph(graph, { mode: 'run' })),
    [graph],
  );
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const canUndo = past.length > 0 && !locked;
  const canRedo = future.length > 0 && !locked;

  const focusIssue = useCallback(
    (issue: ImageIssue) => {
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
    setFlash(
      result.ok ? null : (result.message ?? 'Could not delete the selection.'),
    );
  }, [locked, removeEdge, removeNode, selection]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) {
        return;
      }
      // A dialog owns its keyboard surface: graph Delete/Backspace and undo/redo
      // must not mutate the graph behind it.
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
    const seed = useImageStore.getState().seed;
    downloadImageText(
      serializeImageState(graph, seed),
      `${IMAGE_LEVEL_ID}-${IMAGE_CONTENT_VERSION}-seed-${seed}.json`,
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
    if (file.size > IMAGE_MAX_IMPORT_BYTES) {
      setImportMessage({
        tone: 'danger',
        text: 'The file is larger than 1 MiB — import rejected, the graph was not changed.',
      });
      return;
    }
    try {
      const text = await file.text();
      const result = parseImageState(text, file.size);
      if (!result.ok) {
        setImportMessage({
          tone: 'danger',
          text: `Open rejected, the graph was not changed. ${result.message}`,
        });
        return;
      }
      const openedSeed = result.seed ?? IMAGE_LEVEL.defaultSeed;
      const opened = openState(result.graph, openedSeed);
      if (!opened.ok) {
        setImportMessage({
          tone: 'danger',
          text: `Open rejected, the graph was not changed. ${opened.message ?? 'The graph could not be opened.'}`,
        });
        return;
      }
      setImportMessage({
        tone: 'success',
        text:
          result.format === 'state'
            ? 'Opened the saved graph, positions and seed. Nothing new is saved automatically.'
            : `Opened a graph-only file. The seed was set to the level default (${IMAGE_LEVEL.defaultSeed}).`,
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
        'The Image Atlas starter and default seed have been restored. The previous run result was cleared.',
      );
    }
    setResetMode(null);
  };

  const runEvaluation = () => {
    controller.start({
      graph: useImageStore.getState().graph,
      seed: useImageStore.getState().seed,
    });
    setTelemetryOpen(true);
    const state = useImageStore.getState();
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
    <div className="image-shell">
      <ImageHeader onRun={runEvaluation} onStop={stopEvaluation} />

      <div className="image-notices">
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
        className="image-workspace"
        variant="collapsible"
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
              <ImageBriefing />
            ) : (
              <ImagePalette
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
            panelToggles="always"
            exportTitle="Save the graph, positions and seed to a file. Nothing is saved automatically."
            importTitle="Open a saved graph state file, or an older bare graph JSON file."
            leftActions={
              <Button
                variant="ghost"
                size="sm"
                icon={<Grid2x2 size={15} />}
                disabled={locked}
                title="Move nodes into one lane per region and one column per kind"
                onClick={() => {
                  const result = arrangeByRegion();
                  setFlash(
                    result.ok
                      ? 'Grouped nodes into their regional lanes. Positions remain editable and undoable.'
                      : (result.message ?? null),
                  );
                }}
              >
                Group by region
              </Button>
            }
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
          <ImageCanvas
            suppressAutoFit={telemetryResizing}
            onSelected={() => {
              setInspectorTab('properties');
              setRightOpen(true);
              if (compact) {
                setLeftOpen(false);
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
              onCommit={(value) => writeImageTelemetryHeight(value)}
              onResizeStart={() => setTelemetryResizing(true)}
              onResizeEnd={() => setTelemetryResizing(false)}
            />
          ) : null
        }
        telemetry={
          <ImageResultsPanel
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
            <ImageInspector tab={inspectorTab} setTab={setInspectorTab} />
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
        <ImageConnectDialog
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
          title="Restore the Image Atlas starter?"
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
            The current graph and edit history will be replaced by the level starter and
            the default seed. The previous run result is cleared, so the level starts
            ready to run. Nothing is saved automatically; use Export before resetting if
            you want a file. A saved file is never deleted by Reset.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
