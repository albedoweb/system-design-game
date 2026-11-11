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
  scoreboardGraphDigest,
  scoreboardLinkRole,
  validateScoreboardGraph,
} from '../index';
import { useScoreboardStore } from './scoreboard-store';
import {
  scoreboardLinkColor,
  scoreboardLinkLabel,
  scoreboardRoleOfKinds,
} from './scoreboard-meta';
import {
  scoreboardProblemMaps,
  scoreboardResultStale,
} from './scoreboard-diagnostics';
import {
  buildTrafficEdgeView,
  type TrafficEdgeView,
  type TrafficNodeView,
} from '../../features/traffic/traffic-ui';
import { useTrafficStore } from '../../features/traffic/traffic-store';
import { TrafficStatusBadge } from '../../features/traffic/TrafficStatusBadge';
import { TrafficReplayControl } from '../../features/traffic/TrafficReplayControl';
import {
  SCOREBOARD_TRAFFIC_LEVEL,
  useScoreboardTrafficView,
} from './scoreboard-traffic';
import { ScoreboardEdge, type ScoreboardCanvasEdge } from './ScoreboardEdge';
import {
  ScoreboardNode,
  type ScoreboardCanvasNode,
} from './ScoreboardNode';
import './scoreboard.css';

const nodeTypes = { scoreboard: ScoreboardNode } satisfies NodeTypes;
const edgeTypes = { scoreboard: ScoreboardEdge } satisfies EdgeTypes;
const fitViewOptions = { padding: 0.24, maxZoom: 1.0 };

function CanvasZoomControls() {
  const { zoomIn, zoomOut } = useReactFlow();
  return (
    <div className="scoreboard-zoom" role="toolbar" aria-label="Canvas zoom">
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

export interface ScoreboardConnectRequest {
  source: string;
  target: string;
}

function ScoreboardCanvasInner({
  suppressAutoFit,
  onSelected,
}: {
  suppressAutoFit?: boolean;
  onSelected?: () => void;
}) {
  const graph = useScoreboardStore((state) => state.graph);
  const selection = useScoreboardStore((state) => state.selection);
  const seed = useScoreboardStore((state) => state.seed);
  const result = useScoreboardStore((state) => state.result);
  const resultDigest = useScoreboardStore((state) => state.resultDigest);
  const resultSeed = useScoreboardStore((state) => state.resultSeed);
  const runPhase = useScoreboardStore((state) => state.runPhase);
  const runId = useScoreboardStore((state) => state.runId);
  const addEdge = useScoreboardStore((state) => state.addEdge);
  const moveNode = useScoreboardStore((state) => state.moveNode);
  const beginMove = useScoreboardStore((state) => state.beginMove);
  const endMove = useScoreboardStore((state) => state.endMove);
  const select = useScoreboardStore((state) => state.select);
  const clearSelection = useScoreboardStore((state) => state.clearSelection);

  const [connectionError, setConnectionError] = useState<string | null>(null);
  const { fitView } = useReactFlow();
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);
  const nodeCountRef = useRef(graph.nodes.length);

  const locked = runPhase === 'running' || runPhase === 'stopping';
  const stale = scoreboardResultStale(
    result,
    resultDigest,
    resultSeed,
    graph,
    seed,
  );
  const traffic = useScoreboardTrafficView(runId);

  const currentDigest = useMemo(() => scoreboardGraphDigest(graph), [graph]);
  const bindingDigest =
    result && !stale && resultDigest !== null ? resultDigest : currentDigest;
  useEffect(() => {
    useTrafficStore.getState().syncRunBinding({
      levelId: SCOREBOARD_TRAFFIC_LEVEL,
      runId,
      binding: `live-scoreboard|digest${bindingDigest}|seed${seed}`,
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
    () =>
      new Map((traffic.frame?.edges ?? []).map((edge) => [edge.edgeId, edge])),
    [traffic.frame],
  );

  const validationIssues = useMemo(
    () => validateScoreboardGraph(graph),
    [graph],
  );
  const problems = useMemo(
    () =>
      scoreboardProblemMaps(
        [
          ...validationIssues,
          ...(result && !stale ? result.issues : []),
        ],
        result && !stale ? result : null,
      ),
    [result, stale, validationIssues],
  );

  const metricsByNode = useMemo(
    () =>
      new Map(
        (result && !stale ? result.nodes : []).map((metrics) => [
          metrics.nodeId,
          metrics,
        ]),
      ),
    [result, stale],
  );

  const nodes = useMemo<ScoreboardCanvasNode[]>(
    () =>
      graph.nodes.map((node) => {
        const trafficNode = trafficNodesById.get(node.id) ?? null;
        const offered =
          node.kind === 'users' && result && !stale && result.operations
            ? {
                read: result.operations.read.offered,
                write: result.operations.write.offered,
              }
            : null;
        const sampleActive = traffic.frame !== null;
        const nodeView: TrafficNodeView = {
          node: trafficNode,
          modeLabel: traffic.modeLabel,
          sampleActive,
          animate: traffic.animate,
          showPlaceholder: metricsByNode.size === 0 && !sampleActive,
        };
        return {
          id: node.id,
          type: 'scoreboard' as const,
          position: node.position,
          selected: selection?.type === 'node' && selection.id === node.id,
          draggable: true,
          ariaLabel: `${node.label}, ${node.kind}`,
          data: {
            label: node.label,
            kind: node.kind,
            config: node.config,
            metrics: metricsByNode.get(node.id) ?? null,
            offeredRead: offered?.read ?? null,
            offeredWrite: offered?.write ?? null,
            stale,
            problem: problems.byNode.get(node.id) ?? null,
            traffic: nodeView,
          },
        };
      }),
    [
      graph.nodes,
      metricsByNode,
      problems.byNode,
      result,
      selection,
      stale,
      traffic.animate,
      traffic.frame,
      traffic.modeLabel,
      trafficNodesById,
    ],
  );

  const edges = useMemo<ScoreboardCanvasEdge[]>(
    () =>
      graph.edges.map((edge) => {
        const from = graph.nodes.find((node) => node.id === edge.from);
        const to = graph.nodes.find((node) => node.id === edge.to);
        const role =
          from && to ? scoreboardLinkRole(from.kind, to.kind) : null;
        const color = scoreboardLinkColor(role);
        const trafficEdgeView: TrafficEdgeView | null = buildTrafficEdgeView({
          edge: trafficEdgesById.get(edge.id) ?? null,
          frame: traffic.frame,
          modeLabel: traffic.modeLabel,
          animate: traffic.animate,
          reducedMotion: traffic.reducedMotion,
        });
        return {
          id: edge.id,
          type: 'scoreboard',
          source: edge.from,
          target: edge.to,
          selected: selection?.type === 'edge' && selection.id === edge.id,
          data: {
            role,
            label: scoreboardLinkLabel(role),
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
      graph.edges,
      graph.nodes,
      problems.byEdge,
      selection,
      traffic.animate,
      traffic.frame,
      traffic.modeLabel,
      traffic.reducedMotion,
      trafficEdgesById,
    ],
  );

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

  const onNodesChange = useCallback<OnNodesChange<ScoreboardCanvasNode>>(
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
        setConnectionError('Component settings and connections are locked while the evaluation runs. You can still move components.');
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
      if (scoreboardRoleOfKinds(source.kind, target.kind) === null) {
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
    (_event: unknown, node: ScoreboardCanvasNode) => {
      select({ type: 'node', id: node.id });
      onSelected?.();
    },
    [onSelected, select],
  );

  const onEdgeClick = useCallback(
    (_event: unknown, edge: ScoreboardCanvasEdge) => {
      select({ type: 'edge', id: edge.id });
      onSelected?.();
    },
    [onSelected, select],
  );

  return (
    <div className="scoreboard-canvas-shell">
      <ReactFlow<ScoreboardCanvasNode, ScoreboardCanvasEdge>
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
      <TrafficStatusBadge view={traffic} />
      <TrafficReplayControl
        levelId={SCOREBOARD_TRAFFIC_LEVEL}
        runId={runId}
        enabled={result !== null && !stale}
      />
      {stale ? (
        <div
          className="scoreboard-canvas-note scoreboard-canvas-note--stale"
          role="status"
        >
          Previous result — the semantic graph or seed changed. Metrics and
          pressure highlights are hidden until you run again. Moving a node does
          not invalidate a result.
        </div>
      ) : null}
      {locked ? (
        <div
          className="scoreboard-canvas-note scoreboard-canvas-note--locked"
          role="status"
        >
          Evaluation running · settings and connections are locked. You can still move components. Stop is available.
        </div>
      ) : null}
      {connectionError ? (
        <div className="scoreboard-canvas-alert" role="alert">
          <span>{connectionError}</span>
          <button type="button" onClick={() => setConnectionError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ScoreboardCanvas(props: {
  suppressAutoFit?: boolean;
  onSelected?: () => void;
}) {
  return (
    <ReactFlowProvider>
      <ScoreboardCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
