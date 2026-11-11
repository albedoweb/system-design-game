import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';

import {
  AUDIENCE_CONTENT_VERSION,
  AUDIENCE_LEVEL,
  validateAudienceGraph,
  type AudienceIssue,
} from '../index';
import { Button } from '../../ui/Button';
import { Modal } from '../../ui/Modal';
import {
  Notice,
  SidePanel,
  TelemetryPanel,
  WorkspaceLayout,
  WorkspaceToolbar,
} from '../../features/game-ui';
import { TelemetryResizer } from '../../features/shell/TelemetryResizer';
import { useMediaQuery } from '../../ui/use-media-query';
import { formatInteger } from '../../ui/format';
import { AudienceBriefing } from './AudienceBriefing';
import {
  AudienceCanvas,
  type AudienceConnectRequest,
} from './AudienceCanvas';
import { AudienceConnectDialog } from './AudienceConnectDialog';
import { AudienceHeader } from './AudienceHeader';
import {
  AudienceInspector,
  type AudienceInspectorTab,
} from './AudienceInspector';
import { AudiencePalette } from './AudiencePalette';
import { AudienceResultsPanel } from './AudienceResultsPanel';
import {
  AUDIENCE_MAX_IMPORT_BYTES,
  downloadAudienceText,
  parseAudienceState,
  serializeAudienceState,
} from './audience-persistence';
import {
  audienceResultStale,
  uniqueAudienceIssues,
} from './audience-diagnostics';
import {
  audienceCaseLabel,
  isUntouchedAudienceStarter,
} from './audience-meta';
import { createAudienceRunController } from './audience-run-controller';
import { useAudienceStore } from './audience-store';
import './audience.css';

type LeftTab = 'task' | 'palette';

const DEFAULT_TELEMETRY_HEIGHT = 360;

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

export function AudienceWorkspace() {
  const graph = useAudienceStore((state) => state.graph);
  const selection = useAudienceStore((state) => state.selection);
  const past = useAudienceStore((state) => state.past);
  const future = useAudienceStore((state) => state.future);
  const runPhase = useAudienceStore((state) => state.runPhase);
  const progress = useAudienceStore((state) => state.progress);
  const result = useAudienceStore((state) => state.result);
  const resultDigest = useAudienceStore((state) => state.resultDigest);
  const resultSeed = useAudienceStore((state) => state.resultSeed);
  const seed = useAudienceStore((state) => state.seed);
  const undo = useAudienceStore((state) => state.undo);
  const redo = useAudienceStore((state) => state.redo);
  const resetGraph = useAudienceStore((state) => state.resetGraph);
  const openState = useAudienceStore((state) => state.openState);
  const removeNode = useAudienceStore((state) => state.removeNode);
  const removeEdge = useAudienceStore((state) => state.removeEdge);
  const clearSelection = useAudienceStore((state) => state.clearSelection);
  const select = useAudienceStore((state) => state.select);
  const requestFocusNode = useAudienceStore((state) => state.requestFocusNode);

  const compact = useMediaQuery('(max-width: 1360px)');
  const [controller] = useState(() => createAudienceRunController());
  const [leftTab, setLeftTab] = useState<LeftTab>('task');
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [inspectorTab, setInspectorTab] =
    useState<AudienceInspectorTab>('properties');
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectInitial, setConnectInitial] =
    useState<AudienceConnectRequest | undefined>();
  const [resetOpen, setResetOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<{
    tone: 'success' | 'danger';
    text: string;
  } | null>(null);
  const [telemetryOpen, setTelemetryOpen] = useState(false);
  const [telemetryHeight, setTelemetryHeight] = useState<number | null>(
    DEFAULT_TELEMETRY_HEIGHT,
  );
  const [telemetryResizing, setTelemetryResizing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const resultsPanelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    return () => controller.dispose();
  }, [controller]);

  const locked = runPhase === 'running' || runPhase === 'stopping';
  const issues = useMemo(
    () => uniqueAudienceIssues(validateAudienceGraph(graph)),
    [graph],
  );
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const starter = isUntouchedAudienceStarter(graph);
  const canUndo = past.length > 0 && !locked;
  const canRedo = future.length > 0 && !locked;

  const stale = audienceResultStale(
    result,
    resultDigest,
    resultSeed,
    graph,
    seed,
  );

  const focusIssue = useCallback(
    (issue: AudienceIssue) => {
      if (issue.nodeId) {
        select({ type: 'node', id: issue.nodeId });
        requestFocusNode(issue.nodeId);
      } else if (issue.edgeId) {
        select({ type: 'edge', id: issue.edgeId });
      }
      if (compact) {
        setRightOpen(true);
        setLeftOpen(false);
      }
      setInspectorTab('issues');
    },
    [compact, requestFocusNode, select],
  );

  const focusNode = useCallback(
    (id: string) => {
      select({ type: 'node', id });
      requestFocusNode(id);
      if (compact) {
        setRightOpen(true);
        setLeftOpen(false);
      }
      setInspectorTab('properties');
    },
    [compact, requestFocusNode, select],
  );

  const focusEdge = useCallback(
    (id: string) => {
      select({ type: 'edge', id });
      if (compact) {
        setRightOpen(true);
        setLeftOpen(false);
      }
      setInspectorTab('properties');
    },
    [compact, select],
  );

  const handleDeleteSelection = useCallback(() => {
    if (!selection) {
      return;
    }
    if (locked) {
      setFlash(
        'Component settings and connections are locked while the evaluation runs. You can still move components.',
      );
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
      if (connectOpen || resetOpen || isInsideDialog(event.target)) {
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
    resetOpen,
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
    downloadAudienceText(
      serializeAudienceState(graph, seed),
      `${AUDIENCE_LEVEL.id}-${AUDIENCE_CONTENT_VERSION}-seed-${seed}.json`,
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
    if (file.size > AUDIENCE_MAX_IMPORT_BYTES) {
      setImportMessage({
        tone: 'danger',
        text: 'The file is larger than 1 MiB — open rejected, the graph was not changed.',
      });
      return;
    }
    try {
      const text = await file.text();
      const parsed = parseAudienceState(text, file.size);
      if (!parsed.ok) {
        setImportMessage({
          tone: 'danger',
          text: `Open rejected, the graph was not changed. ${parsed.message}`,
        });
        return;
      }
      const openedSeed = parsed.seed ?? AUDIENCE_LEVEL.defaultSeed;
      openState(parsed.graph, openedSeed);
      setImportMessage({
        tone: 'success',
        text:
          parsed.format === 'state'
            ? 'Opened the saved graph, positions and seed. Nothing new is saved automatically.'
            : `Opened a graph-only file. The seed was set to the level default (${AUDIENCE_LEVEL.defaultSeed}).`,
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
    resetGraph();
    setResetOpen(false);
    setFlash(
      'The Users-only starter and the default seed have been restored. The previous run result was cleared.',
    );
  };

  const runEvaluation = () => {
    controller.start({
      graph: useAudienceStore.getState().graph,
      seed: useAudienceStore.getState().seed,
    });
    setTelemetryOpen(true);
    const state = useAudienceStore.getState();
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

  const telemetrySummary = (() => {
    if (runPhase === 'running') {
      return progress
        ? `${progress.phase}${
            progress.caseId ? ` · ${audienceCaseLabel(progress.caseId)}` : ''
          } · ${formatInteger(progress.completedRequests)}/${
            progress.totalRequests > 0
              ? formatInteger(progress.totalRequests)
              : '?'
          }`
        : 'Starting';
    }
    if (runPhase === 'stopping') {
      return 'Stopping';
    }
    if (stale) {
      return 'Previous result';
    }
    if (result) {
      return result.status === 'complete'
        ? result.passed
          ? 'All cases passed'
          : 'Not qualified'
        : result.status === 'incomplete'
          ? 'Incomplete'
          : result.status === 'cancelled'
            ? 'Cancelled'
            : 'Blocked';
    }
    if (runPhase === 'error') {
      return 'Run failed';
    }
    return 'No result yet';
  })();

  return (
    <div className="audience-shell">
      <AudienceHeader onRun={runEvaluation} onStop={stopEvaluation} />

      <div className="audience-notices">
        {starter ? (
          <Notice tone="info" title="Build your system">
            <p>
              Add an Application and a SQL Database from Components, then
              connect Users → Application → SQL Database. Add a Managed Load
              Balancer, Cache or Worker pool only if your design uses them.
              Validation issues stay in the Issues tab until the graph is
              complete.
            </p>
          </Notice>
        ) : issues.length > 0 ? (
          <Notice
            tone={errorCount > 0 ? 'danger' : 'warning'}
            title={
              errorCount > 0
                ? `Run will be blocked by ${errorCount} error${
                    errorCount === 1 ? '' : 's'
                  }`
                : `${issues.length} warning${
                    issues.length === 1 ? '' : 's'
                  } — the graph can run`
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
        className="audience-workspace"
        leftOpen={leftOpen}
        rightOpen={rightOpen}
        compact={compact}
        onClosePanels={() => {
          setLeftOpen(false);
          setRightOpen(false);
        }}
        splitRef={splitRef}
        backdropLabel="Close panels"
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
            tabsLabel="Left panel"
            closeLabel="Close left panel"
          >
            {leftTab === 'task' ? (
              <AudienceBriefing />
            ) : (
              <AudiencePalette
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
            onReset={() => setResetOpen(true)}
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
            exportTitle="Save the graph, positions and seed to a file. Nothing is saved automatically."
            importTitle="Open a saved graph state file, or an older graph-only JSON file."
            panelToggles="compact-only"
          />
        }
        canvas={
          <AudienceCanvas
            suppressAutoFit={telemetryResizing}
            onSelected={() => {
              if (compact) {
                setRightOpen(true);
                setLeftOpen(false);
                setInspectorTab('properties');
              }
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
              onCommit={setTelemetryHeight}
              onResizeStart={() => setTelemetryResizing(true)}
              onResizeEnd={() => setTelemetryResizing(false)}
            />
          ) : null
        }
        telemetry={
          <TelemetryPanel
            title="Results & telemetry"
            summary={telemetrySummary}
            open={telemetryOpen}
            onOpenChange={changeTelemetryOpen}
            height={telemetryHeight}
            panelRef={resultsPanelRef}
            bodyId="audience-results-body"
            ariaLabel="Results and telemetry"
            className="audience-results-panel"
          >
            <AudienceResultsPanel
              onFocusNode={focusNode}
              onFocusEdge={focusEdge}
            />
          </TelemetryPanel>
        }
        rightPanel={
          <SidePanel
            side="right"
            label="Inspector"
            open={rightOpen}
            onClose={() => setRightOpen(false)}
            tabs={[
              { id: 'properties', label: 'Properties' },
              { id: 'issues', label: 'Issues' },
            ]}
            activeTab={inspectorTab}
            onTabChange={(id) =>
              setInspectorTab(id as AudienceInspectorTab)
            }
            tabsLabel="Inspector tabs"
            closeLabel="Close inspector"
          >
            <AudienceInspector
              tab={inspectorTab}
              onFocusNode={focusNode}
              onFocusEdge={focusEdge}
            />
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
        <AudienceConnectDialog
          graph={graph}
          locked={locked}
          initial={connectInitial}
          onClose={() => {
            setConnectOpen(false);
            setConnectInitial(undefined);
          }}
        />
      ) : null}

      {resetOpen ? (
        <Modal
          title="Restore the Live Audience starter?"
          onClose={() => setResetOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setResetOpen(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={resetAction}>
                Reset graph
              </Button>
            </>
          }
        >
          <p>
            The graph and edit history will be replaced by the Users-only starter
            and the default seed. The previous run result is cleared. Nothing is
            saved automatically; use Export before resetting if you want a file.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
