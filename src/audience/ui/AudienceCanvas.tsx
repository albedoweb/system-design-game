import {
  Background,
  BackgroundVariant,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Connection,
  type EdgeTypes,
  type NodeTypes,
  type OnNodesChange,
} from '@xyflow/react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  audienceGraphDigest,
  audienceLinkRole,
  validateAudienceGraph,
  type AudienceCaseId,
} from '../index';
import { useAudienceStore, audienceSelectedCase } from './audience-store';
import {
  audienceCaseLabel,
  audienceLinkColor,
  audienceLinkLabel,
  audienceRoleOfKinds,
  isUntouchedAudienceStarter,
} from './audience-meta';
import {
  audienceProblemMaps,
  audienceResultStale,
  mergeAudienceProblemMaps,
} from './audience-diagnostics';
import {
  audienceCaseFrames,
  audienceFrameModeLabel,
  audienceTrafficEdgesById,
  audienceTrafficNodeView,
  audienceTrafficNodesById,
  nearestAudienceFrame,
  nearestAudienceSeriesPoint,
} from './audience-frames';
import {
  buildTrafficEdgeView,
  type TrafficEdgeView,
} from '../../features/traffic/traffic-ui';
import { useTrafficStore } from '../../features/traffic/traffic-store';
import { TrafficStatusBadge } from '../../features/traffic/TrafficStatusBadge';
import { useTrafficCanvasView } from '../../features/traffic/use-traffic-view';
import { AUDIENCE_TRAFFIC_LEVEL } from './audience-run-controller';
import { AudienceEdge, type AudienceCanvasEdge } from './AudienceEdge';
import {
  AudienceNode,
  type AudienceCanvasNode,
  type AudienceInstanceHealthView,
} from './AudienceNode';
import { AudienceReplayControl } from './AudienceReplayControl';
import './audience.css';

const nodeTypes = { audience: AudienceNode } satisfies NodeTypes;
const edgeTypes = { audience: AudienceEdge } satisfies EdgeTypes;
const fitViewOptions = { padding: 0.24, maxZoom: 1.0 };

function CanvasZoomControls() {
  const { zoomIn, zoomOut } = useReactFlow();
  return (
    <div className="audience-zoom" role="toolbar" aria-label="Canvas zoom">
      <button type="button" onClick={() => void zoomOut()} aria-label="Zoom out">
        <ZoomOut size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => void zoomIn()}
        aria-label="Zoom in"
      >
        <ZoomIn size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

export interface AudienceConnectRequest {
  source: string;
  target: string;
}

function configuredInstances(
  kind: string,
  config: Record<string, unknown>,
): number {
  if (kind === 'app' || kind === 'worker') {
    return typeof config.instances === 'number' ? config.instances : 1;
  }
  if (kind === 'users') {
    return 0;
  }
  return 1;
}

function faultTargetForCase(
  caseId: AudienceCaseId | null,
): number | null {
  if (!caseId || !caseId.startsWith('app-failure-')) {
    return null;
  }
  return Number(caseId.slice('app-failure-'.length));
}

function AudienceCanvasInner({
  suppressAutoFit,
  onSelected,
}: {
  suppressAutoFit?: boolean;
  onSelected?: () => void;
}) {
  const graph = useAudienceStore((state) => state.graph);
  const selection = useAudienceStore((state) => state.selection);
  const seed = useAudienceStore((state) => state.seed);
  const result = useAudienceStore((state) => state.result);
  const resultDigest = useAudienceStore((state) => state.resultDigest);
  const resultSeed = useAudienceStore((state) => state.resultSeed);
  const runPhase = useAudienceStore((state) => state.runPhase);
  const runId = useAudienceStore((state) => state.runId);
  const progress = useAudienceStore((state) => state.progress);
  const selectedCaseId = useAudienceStore((state) => state.selectedCaseId);
  const viewTimeMs = useAudienceStore((state) => state.viewTimeMs);
  const replayMode = useAudienceStore((state) => state.replayMode);
  const viewportEpoch = useAudienceStore((state) => state.viewportEpoch);
  const focusNodeId = useAudienceStore((state) => state.focusNodeId);
  const focusNonce = useAudienceStore((state) => state.focusNonce);
  const startReplay = useAudienceStore((state) => state.startReplay);
  const playReplay = useAudienceStore((state) => state.playReplay);
  const pauseReplay = useAudienceStore((state) => state.pauseReplay);
  const seekReplay = useAudienceStore((state) => state.seekReplay);
  const advanceReplay = useAudienceStore((state) => state.advanceReplay);
  const exitReplay = useAudienceStore((state) => state.exitReplay);
  const addEdge = useAudienceStore((state) => state.addEdge);
  const moveNode = useAudienceStore((state) => state.moveNode);
  const beginMove = useAudienceStore((state) => state.beginMove);
  const endMove = useAudienceStore((state) => state.endMove);
  const select = useAudienceStore((state) => state.select);
  const clearSelection = useAudienceStore((state) => state.clearSelection);

  const [connectionError, setConnectionError] = useState<string | null>(null);
  const { fitView, setCenter, getZoom } = useReactFlow();
  // Controlled nodes do not carry `measured` back into our array, so use the
  // internal lookup. This is the actual "geometry is known" signal that makes
  // a deferred fitView safe.
  const nodesReady = useStore((state) => {
    if (state.nodeLookup.size === 0) {
      return false;
    }
    for (const node of state.nodeLookup.values()) {
      if (
        node.measured === undefined ||
        node.measured.width === undefined ||
        node.measured.height === undefined
      ) {
        return false;
      }
    }
    return true;
  });
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);
  const lastFitEpochRef = useRef<number | null>(null);
  const lastFocusNonceRef = useRef(focusNonce);

  const locked = runPhase === 'running' || runPhase === 'stopping';
  const stale = audienceResultStale(
    result,
    resultDigest,
    resultSeed,
    graph,
    seed,
  );
  const liveTraffic = useTrafficCanvasView(AUDIENCE_TRAFFIC_LEVEL, runId);
  const selectedCase = audienceSelectedCase(result, selectedCaseId);
  const caseFrames = useMemo(
    () => (stale ? [] : audienceCaseFrames(selectedCase)),
    [selectedCase, stale],
  );
  const recordedMatch = useMemo(
    () => nearestAudienceFrame(caseFrames, viewTimeMs),
    [caseFrames, viewTimeMs],
  );

  const currentDigest = useMemo(() => audienceGraphDigest(graph), [graph]);
  const bindingDigest =
    result && !stale && resultDigest !== null ? resultDigest : currentDigest;
  useEffect(() => {
    useTrafficStore.getState().syncRunBinding({
      levelId: AUDIENCE_TRAFFIC_LEVEL,
      runId,
      binding: `live-audience|digest${bindingDigest}|seed${seed}`,
    });
  }, [bindingDigest, runId, seed]);

  const displayingLive = !stale && liveTraffic.mode === 'live';
  const displayedFrame = displayingLive
    ? liveTraffic.frame
    : recordedMatch?.frame ?? null;
  const recordedPlaying =
    !displayingLive && replayMode === 'playing' && !liveTraffic.reducedMotion;
  const frameModeLabel = displayingLive
    ? liveTraffic.modeLabel
    : recordedMatch
      ? audienceFrameModeLabel(
          recordedMatch.frame,
          recordedPlaying,
          selectedCase ? audienceCaseLabel(selectedCase.id) : null,
        )
      : selectedCase
        ? `${audienceCaseLabel(selectedCase.id)} · summary`
        : 'No recorded frame';

  const trafficNodesById = useMemo(
    () => audienceTrafficNodesById(displayedFrame),
    [displayedFrame],
  );
  const trafficEdgesById = useMemo(
    () => audienceTrafficEdgesById(displayedFrame),
    [displayedFrame],
  );

  const validationIssues = useMemo(
    () => validateAudienceGraph(graph),
    [graph],
  );
  const caseIssues = useMemo(
    () =>
      result && !stale && selectedCase
        ? result.issues.filter(
            (issue) => !issue.caseId || issue.caseId === selectedCase.id,
          )
        : [],
    [result, selectedCase, stale],
  );
  // The untouched Users starter is intentionally incomplete, not a failed
  // simulation. Keep its validation visible in the Issues tab and the
  // Build-your-system notice, but do not paint a red failure badge on Users.
  const starter = isUntouchedAudienceStarter(graph);
  const validationProblems = useMemo(
    () =>
      audienceProblemMaps(starter ? [] : validationIssues, null, 'validation'),
    [starter, validationIssues],
  );
  const runtimeProblems = useMemo(
    () =>
      audienceProblemMaps(
        caseIssues,
        result && !stale ? selectedCase : null,
        'runtime',
      ),
    [caseIssues, result, selectedCase, stale],
  );
  const problems = useMemo(
    () => mergeAudienceProblemMaps(validationProblems, runtimeProblems),
    [runtimeProblems, validationProblems],
  );

  const metricsByNode = useMemo(
    () =>
      new Map(
        (result && !stale && selectedCase ? selectedCase.nodes : []).map(
          (metrics) => [metrics.nodeId, metrics],
        ),
      ),
    [result, selectedCase, stale],
  );
  const seriesPoint = useMemo(
    () =>
      result && !stale && selectedCase && viewTimeMs !== null
        ? nearestAudienceSeriesPoint(selectedCase.series, viewTimeMs)
        : null,
    [result, selectedCase, stale, viewTimeMs],
  );
  const seriesHealth = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const entry of seriesPoint?.nodes ?? []) {
      if (entry.instanceIndex !== null) {
        map.set(`${entry.nodeId}|${entry.instanceIndex}`, entry.healthy);
      }
    }
    return map;
  }, [seriesPoint]);

  const runFaultTarget =
    runPhase === 'running' || runPhase === 'stopping'
      ? faultTargetForCase(progress?.caseId ?? null)
      : null;
  const caseFaultTarget =
    result && !stale && selectedCase?.target?.kind === 'app'
      ? selectedCase.target.instanceIndex
      : faultTargetForCase(selectedCase?.id ?? null);
  const faultTarget = runFaultTarget ?? caseFaultTarget;

  const nodes = useMemo<AudienceCanvasNode[]>(
    () =>
      graph.nodes.map((node) => {
        const metrics = metricsByNode.get(node.id) ?? null;
        const trafficNode = trafficNodesById.get(node.id) ?? null;
        const offered =
          node.kind === 'users' && result && !stale && selectedCase?.operations
            ? {
                ingest: selectedCase.operations.ingest.offered,
                read: selectedCase.operations.read.offered,
              }
            : null;
        const sampleActive = displayedFrame !== null;
        const nodeView = audienceTrafficNodeView({
          node: trafficNode,
          modeLabel: frameModeLabel,
          sampleActive,
          animate: displayingLive ? liveTraffic.animate : recordedPlaying,
          showPlaceholder:
            metricsByNode.size === 0 && !sampleActive && !stale && !locked,
        });

        const targetInstance =
          node.kind === 'app' && faultTarget !== null ? faultTarget : null;
        const total = metrics?.provisionedInstances
          ? metrics.provisionedInstances
          : configuredInstances(node.kind, node.config);
        const instances: AudienceInstanceHealthView[] = Array.from(
          { length: total },
          (_, index) => {
            const fromSeries = seriesHealth.get(`${node.id}|${index}`);
            const fromMetrics = metrics?.instances.find(
              (item) => item.instanceIndex === index,
            );
            return {
              index,
              health:
                fromSeries === undefined
                  ? fromMetrics?.health ?? null
                  : fromSeries
                    ? 'healthy'
                    : 'unhealthy',
              healthy:
                fromSeries === undefined
                  ? fromMetrics
                    ? fromMetrics.health === 'healthy'
                    : null
                  : fromSeries,
              target: targetInstance === index,
            };
          },
        );
        return {
          id: node.id,
          type: 'audience' as const,
          position: node.position,
          selected: selection?.type === 'node' && selection.id === node.id,
          draggable: true,
          ariaLabel: `${node.label}, ${node.kind}`,
          data: {
            label: node.label,
            kind: node.kind,
            config: node.config,
            metrics,
            offeredIngest: offered?.ingest ?? null,
            offeredRead: offered?.read ?? null,
            stale,
            problem: problems.byNode.get(node.id) ?? null,
            traffic: nodeView,
            instanceTotal: total,
            instanceHealthy:
              metrics !== null ? metrics.health.healthyInstances : null,
            instances,
            targetInstance,
            caseLabel:
              targetInstance !== null && selectedCase
                ? audienceCaseLabel(selectedCase.id)
                : targetInstance !== null && progress?.caseId
                  ? audienceCaseLabel(progress.caseId)
                  : null,
          },
        };
      }),
    [
      displayedFrame,
      displayingLive,
      faultTarget,
      frameModeLabel,
      graph.nodes,
      liveTraffic.animate,
      locked,
      metricsByNode,
      problems.byNode,
      progress,
      recordedPlaying,
      result,
      selectedCase,
      selection,
      seriesHealth,
      stale,
      trafficNodesById,
    ],
  );

  const edges = useMemo<AudienceCanvasEdge[]>(
    () =>
      graph.edges.map((edge) => {
        const from = graph.nodes.find((node) => node.id === edge.from);
        const to = graph.nodes.find((node) => node.id === edge.to);
        const role =
          from && to ? audienceLinkRole(from.kind, to.kind) : null;
        const color = audienceLinkColor(role);
        const trafficEdgeView: TrafficEdgeView | null = buildTrafficEdgeView({
          edge: trafficEdgesById.get(edge.id) ?? null,
          frame: displayedFrame,
          modeLabel: frameModeLabel,
          animate: displayingLive ? liveTraffic.animate : recordedPlaying,
          reducedMotion: liveTraffic.reducedMotion,
        });
        return {
          id: edge.id,
          type: 'audience',
          source: edge.from,
          target: edge.to,
          selected: selection?.type === 'edge' && selection.id === edge.id,
          data: {
            role,
            label: audienceLinkLabel(role),
            color,
            problem: problems.byEdge.get(edge.id) ?? null,
            traffic: trafficEdgeView,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color,
            width: 16,
            height: 16,
          },
        };
      }),
    [
      displayedFrame,
      displayingLive,
      frameModeLabel,
      graph.edges,
      graph.nodes,
      liveTraffic.animate,
      liveTraffic.reducedMotion,
      problems.byEdge,
      recordedPlaying,
      selection,
      trafficEdgesById,
    ],
  );

  // Fit only for a fresh viewport (mount, Reset or Import). Adding, removing or
  // resizing cards must not zoom the player's workspace; pan/zoom stays theirs.
  useEffect(() => {
    if (suppressAutoFit || canvasWidth === 0 || canvasHeight === 0) {
      return;
    }
    if (!nodesReady) {
      return;
    }
    if (lastFitEpochRef.current === viewportEpoch) {
      return;
    }
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (cancelled) {
        return;
      }
      // Mark the epoch only when the fit actually runs. A React Flow fitView
      // requested before all nodes have measured dimensions can otherwise
      // execute later, after the player added nodes, and shrink the graph.
      lastFitEpochRef.current = viewportEpoch;
      void fitView({ ...fitViewOptions, duration: 0 });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [
    canvasHeight,
    canvasWidth,
    fitView,
    nodesReady,
    suppressAutoFit,
    viewportEpoch,
  ]);

  // Focus a new selection (or explicit Focus action) by panning at the current
  // zoom. Cards keep their readable size instead of shrinking the whole graph.
  useEffect(() => {
    if (focusNonce === lastFocusNonceRef.current) {
      return;
    }
    const node = graph.nodes.find((item) => item.id === focusNodeId);
    if (!node) {
      return;
    }
    lastFocusNonceRef.current = focusNonce;
    const frame = requestAnimationFrame(() => {
      // A pure pan with duration 0. React Flow's default zoom interpolation can
      // transiently zoom out during a pan even when start/end zoom are equal,
      // and a later focus would capture that mid-animation zoom and ratchet it
      // down on rapid adds.
      void setCenter(node.position.x + 131, node.position.y + 115, {
        zoom: getZoom(),
        duration: 0,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusNodeId, focusNonce, getZoom, graph.nodes, setCenter]);

  const onNodesChange = useCallback<OnNodesChange<AudienceCanvasNode>>(
    (changes) => {
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          moveNode(change.id, change.position);
        }
      }
    },
    [moveNode],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (locked) {
        setConnectionError(
          'Component settings and connections are locked while the evaluation runs. You can still move components.',
        );
        return;
      }
      const source = graph.nodes.find((node) => node.id === connection.source);
      const target = graph.nodes.find((node) => node.id === connection.target);
      if (!source || !target) {
        setConnectionError('Choose a source and a target component.');
        return;
      }
      if (source.id === target.id) {
        setConnectionError('A component cannot connect to itself.');
        return;
      }
      if (audienceRoleOfKinds(source.kind, target.kind) === null) {
        setConnectionError(
          `A ${source.kind} component cannot connect directly to a ${target.kind} component in this level.`,
        );
        return;
      }
      const created = addEdge(source.id, target.id);
      if (!created.ok) {
        setConnectionError(created.message ?? 'Connection rejected.');
        return;
      }
      setConnectionError(null);
    },
    [addEdge, graph.nodes, locked],
  );

  const onNodeClick = useCallback(
    (_event: unknown, node: AudienceCanvasNode) => {
      select({ type: 'node', id: node.id });
      onSelected?.();
    },
    [onSelected, select],
  );

  const onEdgeClick = useCallback(
    (_event: unknown, edge: AudienceCanvasEdge) => {
      select({ type: 'edge', id: edge.id });
      onSelected?.();
    },
    [onSelected, select],
  );

  const showStatus = displayingLive
    ? liveTraffic.showStatus
    : recordedMatch !== null;

  return (
    <div
      className="audience-canvas-shell"
      data-audience-canvas-ready={nodesReady ? 'true' : 'false'}
    >
      <ReactFlow<AudienceCanvasNode, AudienceCanvasEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={() => beginMove()}
        onNodeDragStop={(_event, node) => {
          moveNode(node.id, node.position);
          endMove();
        }}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={() => clearSelection()}
        nodesConnectable={!locked}
        nodesDraggable
        nodesFocusable
        edgesFocusable
        edgesReconnectable={false}
        elementsSelectable
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        minZoom={0.35}
        maxZoom={1.6}
        snapToGrid
        snapGrid={[10, 10]}
        connectionRadius={40}
        connectionLineStyle={{ stroke: '#0e7490', strokeWidth: 2.2 }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.4}
          color="#c9d8e5"
        />
      </ReactFlow>
      <CanvasZoomControls />
      <TrafficStatusBadge
        view={{
          ...liveTraffic,
          mode: displayingLive
            ? liveTraffic.mode
            : recordedMatch
              ? 'replay-paused'
              : 'completed',
          frame: displayedFrame,
          animate: displayingLive ? liveTraffic.animate : recordedPlaying,
          modeLabel: frameModeLabel,
          showStatus,
          awaitingSample: displayingLive && displayedFrame === null,
          paused: recordedMatch !== null && !recordedPlaying,
        }}
      />
      {result && !stale && selectedCase ? (
        <AudienceReplayControl
          frames={caseFrames}
          caseLabel={audienceCaseLabel(selectedCase.id)}
          viewTimeMs={viewTimeMs}
          mode={replayMode}
          onStart={startReplay}
          onPlay={playReplay}
          onPause={pauseReplay}
          onSeek={seekReplay}
          onAdvance={advanceReplay}
          onSummary={exitReplay}
        />
      ) : null}
      {locked ? (
        <div
          className="audience-canvas-note audience-canvas-note--locked"
          role="status"
        >
          Evaluation running · settings and connections are locked. You can
          still move components. Stop is available.
        </div>
      ) : null}
      {stale ? (
        <div
          className="audience-canvas-note audience-canvas-note--stale"
          role="status"
        >
          Previous result — the semantic graph or seed changed. Metrics, fault
          markers and recorded frames are hidden until you run again. Moving a
          node does not invalidate a result.
        </div>
      ) : null}
      {connectionError ? (
        <div className="audience-canvas-alert" role="alert">
          <span>{connectionError}</span>
          <button type="button" onClick={() => setConnectionError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function AudienceCanvas(props: {
  suppressAutoFit?: boolean;
  onSelected?: () => void;
}) {
  return (
    <ReactFlowProvider>
      <AudienceCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
