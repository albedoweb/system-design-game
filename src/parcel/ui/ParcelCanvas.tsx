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

import { parcelSemanticDigest, validateParcelGraph } from '../graph';
import { PARCEL_BUSINESS_OPERATIONS, type ParcelHorizonYears } from '../contracts';
import { useParcelStore } from './parcel-store';
import {
  buildTrafficEdgeView,
  type TrafficEdgeView,
  type TrafficNodeView,
} from '../../features/traffic/traffic-ui';
import { useTrafficCanvasView } from '../../features/traffic/use-traffic-view';
import { useTrafficStore } from '../../features/traffic/traffic-store';
import { TrafficStatusBadge } from '../../features/traffic/TrafficStatusBadge';
import { TrafficReplayControl } from '../../features/traffic/TrafficReplayControl';
import {
  parcelConnectionCandidates,
  parcelConnectionExplanation,
  parcelEdgeLanes,
} from './parcel-canvas-model';
import { parcelProblemMaps, parcelResultStale } from './parcel-diagnostics';
import { formatHorizon } from './parcel-format';
import { ParcelEdge, type ParcelCanvasEdge } from './ParcelEdge';
import { ParcelNode, type ParcelCanvasNode } from './ParcelNode';
import './parcel.css';

const nodeTypes = { parcel: ParcelNode } satisfies NodeTypes;
const edgeTypes = { parcel: ParcelEdge } satisfies EdgeTypes;
const fitViewOptions = { padding: 0.22, maxZoom: 1.0 };

function CanvasZoomControls() {
  const { zoomIn, zoomOut } = useReactFlow();
  return (
    <div className="parcel-zoom" role="toolbar" aria-label="Canvas zoom">
      <button type="button" onClick={() => void zoomOut()} aria-label="Zoom out">
        <ZoomOut size={16} aria-hidden="true" />
      </button>
      <button type="button" onClick={() => void zoomIn()} aria-label="Zoom in">
        <ZoomIn size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

export interface ParcelConnectRequest {
  source: string;
  target: string;
}

function ParcelCanvasInner({
  suppressAutoFit,
  onSelected,
  onRequestConnect,
}: {
  suppressAutoFit?: boolean;
  onSelected?: () => void;
  onRequestConnect: (request: ParcelConnectRequest) => void;
}) {
  const graph = useParcelStore((state) => state.graph);
  const selection = useParcelStore((state) => state.selection);
  const seed = useParcelStore((state) => state.seed);
  const selectedHorizon = useParcelStore((state) => state.selectedHorizon);
  const result = useParcelStore((state) => state.result);
  const resultDigest = useParcelStore((state) => state.resultDigest);
  const resultSeed = useParcelStore((state) => state.resultSeed);
  const runPhase = useParcelStore((state) => state.runPhase);
  const runId = useParcelStore((state) => state.runId);
  const runIssues = useParcelStore((state) => state.runIssues);
  const addEdge = useParcelStore((state) => state.addEdge);
  const moveNode = useParcelStore((state) => state.moveNode);
  const beginMove = useParcelStore((state) => state.beginMove);
  const endMove = useParcelStore((state) => state.endMove);
  const select = useParcelStore((state) => state.select);
  const clearSelection = useParcelStore((state) => state.clearSelection);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const { fitView } = useReactFlow();
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);
  const nodeCountRef = useRef(graph.nodes.length);

  const locked = runPhase === 'running' || runPhase === 'stopping';
  const stale = parcelResultStale(
    result,
    resultDigest,
    resultSeed,
    graph,
    seed,
  );
  const horizon = useMemo<ParcelHorizonYears | null>(() => {
    if (!result || result.status !== 'ok' || stale) {
      return null;
    }
    return selectedHorizon;
  }, [result, selectedHorizon, stale]);
  const horizonResult =
    result && result.status === 'ok' && horizon !== null
      ? result.horizons.find((item) => item.horizonYears === horizon) ?? null
      : null;

  const traffic = useTrafficCanvasView('parcel-pulse', runId);
  const currentDigest = useMemo(() => parcelSemanticDigest(graph), [graph]);
  const bindingDigest =
    result && !stale && resultDigest !== null ? resultDigest : currentDigest;
  useEffect(() => {
    useTrafficStore.getState().syncRunBinding({
      levelId: 'parcel-pulse',
      runId,
      binding: `parcel-pulse|digest${bindingDigest}|seed${seed}`,
    });
  }, [bindingDigest, runId, seed]);

  const trafficNodesById = useMemo(
    () =>
      new Map(
        (traffic.frame?.nodes ?? []).map((node) => [node.nodeId, node]),
      ),
    [traffic.frame],
  );
  const trafficEdgesById = useMemo(
    () => new Map((traffic.frame?.edges ?? []).map((edge) => [edge.edgeId, edge])),
    [traffic.frame],
  );

  const problems = useMemo(() => {
    const validationIssues = validateParcelGraph(graph, { mode: 'edit' });
    const blockedIssues = runPhase === 'blocked' ? runIssues : [];
    const evaluationIssues =
      result && !stale ? result.issues : ([] as typeof validationIssues);
    return parcelProblemMaps(
      graph,
      [...validationIssues, ...blockedIssues, ...evaluationIssues],
      stale ? null : result,
      selectedHorizon,
    );
  }, [graph, result, runIssues, runPhase, selectedHorizon, stale]);

  const metricsByNode = useMemo(
    () =>
      new Map(
        (horizonResult?.nodes ?? []).map((metrics) => [metrics.nodeId, metrics]),
      ),
    [horizonResult],
  );
  const offeredTotal = useMemo(() => {
    if (!horizonResult) {
      return null;
    }
    return PARCEL_BUSINESS_OPERATIONS.reduce(
      (sum, operation) => sum + horizonResult.operations[operation].counts.offered,
      0,
    );
  }, [horizonResult]);

  const nodes = useMemo<ParcelCanvasNode[]>(() => {
    const horizonLabel = horizon === null ? 'Run' : formatHorizon(horizon);
    return graph.nodes.map((node) => {
      const trafficNode = trafficNodesById.get(node.id) ?? null;
      const sampleActive = traffic.frame !== null;
      const nodeView: TrafficNodeView = {
        node: trafficNode,
        modeLabel: traffic.modeLabel,
        sampleActive,
        animate: traffic.animate,
        showPlaceholder: horizonResult === null && !sampleActive,
      };
      return {
        id: node.id,
        type: 'parcel' as const,
        position: node.position,
        selected: selection?.type === 'node' && selection.id === node.id,
        draggable: true,
        ariaLabel: `${node.label}, ${node.kind}`,
        data: {
          label: node.label,
          kind: node.kind,
          config: node.config,
          metrics: metricsByNode.get(node.id) ?? null,
          offeredTotal,
          stale,
          problem: problems.byNode.get(node.id) ?? null,
          horizonLabel,
          traffic: nodeView,
        },
      };
    });
  }, [
    graph.nodes,
    horizon,
    horizonResult,
    metricsByNode,
    offeredTotal,
    problems.byNode,
    selection,
    stale,
    traffic.animate,
    traffic.frame,
    traffic.modeLabel,
    trafficNodesById,
  ]);

  const edges = useMemo<ParcelCanvasEdge[]>(() => {
    const lanes = parcelEdgeLanes(graph.edges);
    return graph.edges.map((edge) => {
      const lane = lanes.get(edge.id);
      const trafficEdgeView: TrafficEdgeView | null = buildTrafficEdgeView({
        edge: trafficEdgesById.get(edge.id) ?? null,
        frame: traffic.frame,
        modeLabel: traffic.modeLabel,
        animate: traffic.animate,
        reducedMotion: traffic.reducedMotion,
      });
      return {
        id: edge.id,
        type: 'parcel',
        source: edge.source,
        target: edge.target,
        selected: selection?.type === 'edge' && selection.id === edge.id,
        data: {
          operation: edge.operation,
          label: edge.operation,
          traffic: trafficEdgeView,
          color:
            edge.operation === 'traffic'
              ? '#0e7490'
              : edge.operation === 'ingest'
                ? '#7c3aed'
                : edge.operation === 'status'
                  ? '#1d6fd8'
                  : edge.operation === 'history'
                    ? '#b45309'
                    : edge.operation === 'report'
                      ? '#0f766e'
                      : '#be123c',
          laneOffset: lane?.offset ?? 0,
          problem: problems.byEdge.get(edge.id) ?? null,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color:
            edge.operation === 'traffic'
              ? '#0e7490'
              : edge.operation === 'ingest'
                ? '#7c3aed'
                : edge.operation === 'status'
                  ? '#1d6fd8'
                  : edge.operation === 'history'
                    ? '#b45309'
                    : edge.operation === 'report'
                      ? '#0f766e'
                      : '#be123c',
          width: 16,
          height: 16,
        },
      };
    });
  }, [
    graph.edges,
    problems.byEdge,
    selection,
    traffic.animate,
    traffic.frame,
    traffic.modeLabel,
    traffic.reducedMotion,
    trafficEdgesById,
  ]);

  useEffect(() => {
    if (suppressAutoFit || canvasWidth === 0 || canvasHeight === 0) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      void fitView({ ...fitViewOptions, duration: 150 });
    });
    return () => cancelAnimationFrame(frame);
  }, [canvasHeight, canvasWidth, fitView, suppressAutoFit]);

  useEffect(() => {
    if (suppressAutoFit) {
      return;
    }
    if (nodeCountRef.current === graph.nodes.length) {
      return;
    }
    nodeCountRef.current = graph.nodes.length;
    const frame = requestAnimationFrame(() => {
      void fitView({ ...fitViewOptions, duration: 180 });
    });
    return () => cancelAnimationFrame(frame);
  }, [fitView, graph.nodes.length, suppressAutoFit]);

  useEffect(() => {
    if (suppressAutoFit || !horizonResult) {
      return;
    }
    // Result badges and meters change node height after the first render.
    const timer = window.setTimeout(() => {
      void fitView({ ...fitViewOptions, duration: 150 });
    }, 140);
    return () => window.clearTimeout(timer);
  }, [fitView, horizonResult, suppressAutoFit]);

  const onNodesChange = useCallback<OnNodesChange<ParcelCanvasNode>>(
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
        setConnectionError('The graph is read-only while the evaluation runs.');
        return;
      }
      const source = graph.nodes.find((node) => node.id === connection.source);
      const target = graph.nodes.find((node) => node.id === connection.target);
      if (!source || !target) {
        setConnectionError('Choose a source and a target node.');
        return;
      }
      const candidates = parcelConnectionCandidates(
        source,
        target,
        graph.edges.filter(
          (edge) =>
            edge.source === source.id && edge.target === target.id,
        ),
      );
      if (candidates.length === 0) {
        setConnectionError(
          parcelConnectionExplanation(source.kind, target.kind),
        );
        return;
      }
      if (candidates.length === 1) {
        const operation = candidates[0];
        if (!operation) {
          return;
        }
        const created = addEdge(source.id, target.id, operation);
        setConnectionError(
          created.ok ? null : (created.message ?? 'Route rejected.'),
        );
        return;
      }
      onRequestConnect({ source: source.id, target: target.id });
    },
    [addEdge, graph.edges, graph.nodes, locked, onRequestConnect],
  );

  const onNodeClick = useCallback(
    (_event: unknown, node: ParcelCanvasNode) => {
      select({ type: 'node', id: node.id });
      onSelected?.();
    },
    [onSelected, select],
  );

  const onEdgeClick = useCallback(
    (_event: unknown, edge: ParcelCanvasEdge) => {
      select({ type: 'edge', id: edge.id });
      onSelected?.();
    },
    [onSelected, select],
  );

  return (
    <div className="parcel-canvas-shell">
      <ReactFlow<ParcelCanvasNode, ParcelCanvasEdge>
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
        fitView
        fitViewOptions={fitViewOptions}
        minZoom={0.35}
        maxZoom={1.6}
        snapToGrid
        snapGrid={[10, 10]}
        connectionRadius={30}
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
      <TrafficStatusBadge view={traffic} />
      <TrafficReplayControl
        levelId="parcel-pulse"
        runId={runId}
        enabled={result?.status === 'ok' && !stale}
      />
      {stale ? (
        <div className="parcel-canvas-note parcel-canvas-note--stale" role="status">
          Previous result — the semantic graph or seed changed. Metrics and failure
          highlights are hidden until you run again. Moving or renaming nodes does
          not invalidate a result.
        </div>
      ) : null}
      {locked ? (
        <div className="parcel-canvas-note parcel-canvas-note--locked" role="status">
          Evaluation running · you can still move and inspect nodes
        </div>
      ) : null}
      {connectionError ? (
        <div className="parcel-canvas-alert" role="alert">
          <span>{connectionError}</span>
          <button type="button" onClick={() => setConnectionError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ParcelCanvas(props: {
  suppressAutoFit?: boolean;
  onSelected?: () => void;
  onRequestConnect: (request: ParcelConnectRequest) => void;
}) {
  return (
    <ReactFlowProvider>
      <ParcelCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
