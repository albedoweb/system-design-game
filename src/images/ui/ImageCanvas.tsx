import {
  Background,
  BackgroundVariant,
  MarkerType,
  Panel,
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

import { imageGraphDigest, validateImageGraph } from '../graph';
import type { ImageRegion, ImageScenarioName } from '../contracts';
import { useImageStore } from './image-store';
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
  imageConnectionCandidates,
  imageConnectionExplanation,
  imageEdgeLanes,
} from './image-canvas-model';
import {
  imageProblemMaps,
  imageResultStale,
} from './image-diagnostics';
import { imageLiveEstimate, imageNodeCapacityLoad } from './image-estimate';
import {
  IMAGE_NODE_EXTENT,
  imageNodeOutsideRegionLane,
  imageRegionLane,
} from './image-layout';
import {
  IMAGE_OPERATION_META,
  IMAGE_REGION_LABELS,
  IMAGE_REGION_ORDER,
  IMAGE_SCENARIO_LABELS,
} from './image-meta';
import { ImageEdge, type ImageCanvasEdge } from './ImageEdge';
import { ImageNode, type ImageCanvasNode } from './ImageNode';
import {
  ImageRegionLaneNodeView,
  type ImageRegionLaneNode,
} from './ImageRegionLane';
import './image.css';

const nodeTypes = {
  image: ImageNode,
  'image-region': ImageRegionLaneNodeView,
} satisfies NodeTypes;
const edgeTypes = { image: ImageEdge } satisfies EdgeTypes;
const fitViewOptions = { padding: 0.08, maxZoom: 1 };

const LANE_NOTES: Readonly<Record<ImageRegion, string>> = {
  na: 'Shared 100 Gbit/s channels to EU (40 ms) and AP (80 ms) one-way',
  eu: 'Shared 100 Gbit/s channels to NA (40 ms) and AP (70 ms) one-way',
  ap: 'Shared 100 Gbit/s channels to NA (80 ms) and EU (70 ms) one-way',
};

function CanvasZoomControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <div className="image-zoom" role="toolbar" aria-label="Canvas zoom">
      <button type="button" onClick={() => void zoomOut()} aria-label="Zoom out">
        <ZoomOut size={16} aria-hidden="true" />
      </button>
      <button type="button" onClick={() => void zoomIn()} aria-label="Zoom in">
        <ZoomIn size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => void fitView(fitViewOptions)}
        aria-label="Fit the graph"
        title="Fit the whole graph"
      >
        <span aria-hidden="true">⤢</span>
      </button>
    </div>
  );
}

export interface ImageConnectRequest {
  source: string;
  target: string;
}

function ImageCanvasInner({
  suppressAutoFit,
  onSelected,
  onRequestConnect,
}: {
  suppressAutoFit?: boolean;
  onSelected?: () => void;
  onRequestConnect: (request: ImageConnectRequest) => void;
}) {
  const graph = useImageStore((state) => state.graph);
  const selection = useImageStore((state) => state.selection);
  const seed = useImageStore((state) => state.seed);
  const result = useImageStore((state) => state.result);
  const resultDigest = useImageStore((state) => state.resultDigest);
  const resultSeed = useImageStore((state) => state.resultSeed);
  const selectedScenario = useImageStore((state) => state.selectedScenario);
  const runPhase = useImageStore((state) => state.runPhase);
  const runId = useImageStore((state) => state.runId);
  const runIssues = useImageStore((state) => state.runIssues);
  const addEdge = useImageStore((state) => state.addEdge);
  const moveNode = useImageStore((state) => state.moveNode);
  const beginMove = useImageStore((state) => state.beginMove);
  const endMove = useImageStore((state) => state.endMove);
  const select = useImageStore((state) => state.select);
  const clearSelection = useImageStore((state) => state.clearSelection);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const { fitView } = useReactFlow();
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);
  const nodeCountRef = useRef(graph.nodes.length);

  const locked = runPhase === 'running' || runPhase === 'stopping';
  const outsideLaneCount = graph.nodes.filter(imageNodeOutsideRegionLane).length;
  const stale = imageResultStale(
    result,
    resultDigest,
    resultSeed,
    graph,
    seed,
  );
  const estimate = useMemo(() => imageLiveEstimate(graph), [graph]);
  const problems = useMemo(() => {
    const validationIssues = validateImageGraph(graph, { mode: 'edit' });
    const blockedIssues = runPhase === 'blocked' ? runIssues : [];
    return imageProblemMaps({
      graph,
      issues: [...validationIssues, ...blockedIssues],
      evaluation: result && !stale ? result : null,
      scenario: stale ? null : selectedScenario,
    });
  }, [graph, result, runIssues, runPhase, selectedScenario, stale]);

  const scenario: ImageScenarioName | null =
    result && !stale && result.status === 'complete'
      ? (result.scenarios.find((item) => item.name === selectedScenario)?.name ??
        result.scenarios[0]?.name ??
        null)
      : null;
  const scenarioLabel =
    scenario === null ? 'No run yet' : IMAGE_SCENARIO_LABELS[scenario];
  const metricsByNode = useMemo(() => {
    const scenarioResult =
      result && !stale
        ? result.scenarios.find((item) => item.name === scenario)
        : null;
    return new Map(
      (scenarioResult?.nodes ?? []).map((metrics) => [metrics.nodeId, metrics]),
    );
  }, [result, scenario, stale]);

  const traffic = useTrafficCanvasView('image-atlas', runId);
  const currentDigest = useMemo(() => imageGraphDigest(graph), [graph]);
  const bindingDigest =
    result && !stale && resultDigest !== null ? resultDigest : currentDigest;
  useEffect(() => {
    useTrafficStore.getState().syncRunBinding({
      levelId: 'image-atlas',
      runId,
      binding: `image-atlas|digest${bindingDigest}|seed${seed}`,
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

  const nodes = useMemo(() => {
    const laneNodes: ImageRegionLaneNode[] = IMAGE_REGION_ORDER.map((region) => {
      const lane = imageRegionLane(region, graph.nodes);
      const regionProblem = problems.byRegion.get(region);
      const members = graph.nodes.filter((node) => node.region === region).length;
      return {
        id: `__region__${region}`,
        type: 'image-region',
        position: { x: lane.left, y: lane.top },
        draggable: false,
        selectable: false,
        connectable: false,
        deletable: false,
        focusable: false,
        data: {
          region,
          nodeCount: members,
          problem:
            regionProblem && regionProblem.severity !== 'info'
              ? (regionProblem.messages[0] ?? null)
              : null,
          note: LANE_NOTES[region],
          width: lane.width,
        },
      };
    });
    const graphNodes: ImageCanvasNode[] = graph.nodes.map((node) => {
      const trafficNode = trafficNodesById.get(node.id) ?? null;
      const sampleActive = traffic.frame !== null;
      const hasResultMetrics = metricsByNode.has(node.id) && !stale;
      const nodeView: TrafficNodeView = {
        node: trafficNode,
        modeLabel: traffic.modeLabel,
        sampleActive,
        animate: traffic.animate,
        showPlaceholder: !hasResultMetrics && !sampleActive,
      };
      return {
        id: node.id,
        type: 'image',
        position: node.position,
        selected: selection?.type === 'node' && selection.id === node.id,
        draggable: true,
        ariaLabel: `${node.label}, ${node.kind} in ${IMAGE_REGION_LABELS[node.region]}`,
        data: {
          label: node.label,
          kind: node.kind,
          region: node.region,
          config: node.config,
          metrics: metricsByNode.get(node.id) ?? null,
          capacity: stale ? null : imageNodeCapacityLoad(estimate.capacity, node.id),
          stale,
          problem: problems.byNode.get(node.id) ?? null,
          scenarioLabel,
          outsideLane: imageNodeOutsideRegionLane(node),
          traffic: nodeView,
        },
      };
    });
    return [...laneNodes, ...graphNodes];
  }, [
    estimate.capacity,
    graph.nodes,
    metricsByNode,
    problems.byNode,
    problems.byRegion,
    scenarioLabel,
    selection,
    stale,
    traffic.animate,
    traffic.frame,
    traffic.modeLabel,
    trafficNodesById,
  ]);

  const edges = useMemo<ImageCanvasEdge[]>(() => {
    const lanes = imageEdgeLanes(graph.edges);
    return graph.edges.map((edge) => {
      const meta = IMAGE_OPERATION_META[edge.operation];
      const trafficEdgeView: TrafficEdgeView | null = buildTrafficEdgeView({
        edge: trafficEdgesById.get(edge.id) ?? null,
        frame: traffic.frame,
        modeLabel: traffic.modeLabel,
        animate: traffic.animate,
        reducedMotion: traffic.reducedMotion,
      });
      return {
        id: edge.id,
        type: 'image' as const,
        source: edge.source,
        target: edge.target,
        selected: selection?.type === 'edge' && selection.id === edge.id,
        data: {
          operation: edge.operation,
          label: meta.label,
          color: meta.color,
          dash: meta.dash,
          lane: lanes.get(edge.id) ?? null,
          problem: problems.byEdge.get(edge.id) ?? null,
          traffic: trafficEdgeView,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: meta.color,
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
    if (suppressAutoFit || metricsByNode.size === 0) {
      return;
    }
    // Result badges and meters change node height after the first render.
    const timer = window.setTimeout(() => {
      void fitView({ ...fitViewOptions, duration: 150 });
    }, 140);
    return () => window.clearTimeout(timer);
  }, [fitView, metricsByNode, suppressAutoFit]);

  const onNodesChange = useCallback<
    OnNodesChange<ImageCanvasNode | ImageRegionLaneNode>
  >(
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
      const candidates = imageConnectionCandidates(
        source,
        target,
        graph.edges.filter(
          (edge) => edge.source === source.id && edge.target === target.id,
        ),
      );
      if (candidates.length === 0) {
        setConnectionError(imageConnectionExplanation(source.kind, target.kind));
        return;
      }
      const only = candidates[0];
      if (candidates.length === 1 && only) {
        const created = addEdge(source.id, target.id, only);
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
    (_event: unknown, node: { id: string }) => {
      select({ type: 'node', id: node.id });
      onSelected?.();
    },
    [onSelected, select],
  );

  const onEdgeClick = useCallback(
    (_event: unknown, edge: ImageCanvasEdge) => {
      select({ type: 'edge', id: edge.id });
      onSelected?.();
    },
    [onSelected, select],
  );

  return (
    <div className="image-canvas-shell">
      <ReactFlow<ImageCanvasNode | ImageRegionLaneNode, ImageCanvasEdge>
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
        nodeExtent={IMAGE_NODE_EXTENT}
        nodesFocusable
        edgesFocusable
        edgesReconnectable={false}
        elementsSelectable
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        fitView
        fitViewOptions={fitViewOptions}
        minZoom={0.28}
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
        <Panel position="bottom-right" className="image-canvas-legend">
          <p className="image-canvas-legend__title">Logical routes, physical links</p>
          <ul className="image-canvas-legend__list">
            {(Object.keys(IMAGE_OPERATION_META) as Array<
              keyof typeof IMAGE_OPERATION_META
            >).map((operation) => (
              <li key={operation}>
                <span
                  className="image-canvas-legend__swatch"
                  style={{
                    background: IMAGE_OPERATION_META[operation].color,
                    ...(IMAGE_OPERATION_META[operation].dash
                      ? {
                          backgroundImage: `repeating-linear-gradient(90deg, ${IMAGE_OPERATION_META[operation].color} 0 4px, transparent 4px 7px)`,
                          backgroundColor: 'transparent',
                        }
                      : {}),
                  }}
                  aria-hidden="true"
                />
                {IMAGE_OPERATION_META[operation].label}
              </li>
            ))}
          </ul>
          <p className="image-canvas-legend__note">
            An arrow is a logical route, never its own cable. Region pairs share one
            100 Gbit/s full-duplex channel and each instance has a 10 Gbit/s NIC.
          </p>
        </Panel>
      </ReactFlow>
      <CanvasZoomControls />
      <TrafficStatusBadge view={traffic} />
      <TrafficReplayControl
        levelId="image-atlas"
        runId={runId}
        enabled={runPhase === 'completed' && result !== null && !stale}
      />
      {stale ? (
        <div className="image-canvas-note image-canvas-note--stale" role="status">
          Previous result — the semantic graph or seed changed. Metrics and failure
          highlights are hidden until you run again. Moving or renaming nodes does
          not invalidate a result.
        </div>
      ) : null}
      {locked || outsideLaneCount > 0 ? (
        <div className="image-canvas-notes">
          {locked ? (
            <div className="image-canvas-note image-canvas-note--locked" role="status">
              Evaluation running · you can still move and inspect nodes
            </div>
          ) : null}
          {outsideLaneCount > 0 ? (
            <div className="image-canvas-note image-canvas-note--layout" role="status">
              {outsideLaneCount} node{outsideLaneCount === 1 ? ' is' : 's are'} drawn
              outside its regional lane. This is layout only — “Group by region” tidies
              positions without changing the model.
            </div>
          ) : null}
        </div>
      ) : null}
      {connectionError ? (
        <div className="image-canvas-alert" role="alert">
          <span>{connectionError}</span>
          <button type="button" onClick={() => setConnectionError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ImageCanvas(props: {
  suppressAutoFit?: boolean;
  onSelected?: () => void;
  onRequestConnect: (request: ImageConnectRequest) => void;
}) {
  return (
    <ReactFlowProvider>
      <ImageCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
