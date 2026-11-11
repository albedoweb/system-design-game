import {
  Background,
  BackgroundVariant,
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

import type {
  EdgeSourcePort,
  GraphDocument,
  SimulationSnapshot,
} from '../../domain';
import { useEditorStore, type EditorSelection } from '../../state/editor-store';
import { useSessionStore } from '../../state/session-store';
import {
  buildTrafficEdgeView,
  type TrafficEdgeView,
  type TrafficNodeView,
} from '../traffic/traffic-ui';
import { useTrafficCanvasView } from '../traffic/use-traffic-view';
import { useTrafficStore } from '../traffic/traffic-store';
import { TrafficStatusBadge } from '../traffic/TrafficStatusBadge';
import { DomainEdge } from './DomainEdge';
import { DomainNode } from './DomainNode';
import {
  toCanvasEdges,
  toCanvasNodes,
  type CanvasEdge,
  type CanvasEvidence,
  type CanvasNode,
} from './canvas-model';
import './editor.css';

const nodeTypes = { domain: DomainNode } satisfies NodeTypes;
const edgeTypes = { domain: DomainEdge } satisfies EdgeTypes;
const fitViewOptions = { padding: 0.2, maxZoom: 1.1 };
const VALID_PORTS = new Set<EdgeSourcePort>(['out', 'read', 'write', 'miss']);

function CanvasZoomControls() {
  const { zoomIn, zoomOut } = useReactFlow();
  return (
    <div className="canvas-zoom" role="toolbar" aria-label="Canvas zoom">
      <button type="button" onClick={() => zoomOut()} aria-label="Zoom out">
        <ZoomOut size={16} aria-hidden="true" />
      </button>
      <button type="button" onClick={() => zoomIn()} aria-label="Zoom in">
        <ZoomIn size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

function CanvasInner({
  graph,
  selection,
  locked,
  snapshot,
  evidence,
  suppressAutoFit,
  onSelected,
}: {
  graph: GraphDocument;
  selection: EditorSelection;
  locked: boolean;
  snapshot: SimulationSnapshot | null;
  evidence: CanvasEvidence;
  suppressAutoFit?: boolean;
  onSelected?: () => void;
}) {
  const addEdge = useEditorStore((state) => state.addEdge);
  const moveNode = useEditorStore((state) => state.moveNode);
  const beginMove = useEditorStore((state) => state.beginMove);
  const endMove = useEditorStore((state) => state.endMove);
  const select = useEditorStore((state) => state.select);
  const clearSelection = useEditorStore((state) => state.clearSelection);
  const configRevision = useEditorStore((state) => state.configRevision);
  const runId = useSessionStore((state) => state.runId);
  const seed = useSessionStore((state) => state.seed);
  const traffic = useTrafficCanvasView('cold-cache', runId);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const { fitView } = useReactFlow();
  const nodeCountRef = useRef(graph.nodes.length);
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);

  useEffect(() => {
    if (suppressAutoFit) return;
    if (canvasWidth === 0 || canvasHeight === 0) return;
    const frame = requestAnimationFrame(() => {
      void fitView({ ...fitViewOptions, duration: 150 });
    });
    return () => cancelAnimationFrame(frame);
  }, [canvasWidth, canvasHeight, fitView, suppressAutoFit]);

  useEffect(() => {
    if (suppressAutoFit) return;
    if (nodeCountRef.current === graph.nodes.length) {
      return;
    }
    nodeCountRef.current = graph.nodes.length;
    void fitView({ padding: 0.2, duration: 180 });
  }, [fitView, graph.nodes.length, suppressAutoFit]);

  useEffect(() => {
    useTrafficStore.getState().syncRunBinding({
      levelId: 'cold-cache',
      runId,
      binding: `cold-cache|rev${configRevision}|seed${seed}`,
    });
  }, [configRevision, runId, seed]);

  const metricsByNode = useMemo(
    () => new Map((snapshot?.nodes ?? []).map((metric) => [metric.nodeId, metric])),
    [snapshot],
  );

  const trafficNodesById = useMemo(
    () => new Map((traffic.frame?.nodes ?? []).map((node) => [node.nodeId, node])),
    [traffic.frame],
  );
  const trafficEdgesById = useMemo(
    () => new Map((traffic.frame?.edges ?? []).map((edge) => [edge.edgeId, edge])),
    [traffic.frame],
  );

  const nodes = useMemo(() => {
    const mapped = toCanvasNodes(graph, metricsByNode, evidence);
    return mapped.map((node) => {
      const trafficNode = trafficNodesById.get(node.id) ?? null;
      const sampleActive = traffic.frame !== null;
      const nodeView: TrafficNodeView = {
        node: trafficNode,
        modeLabel: traffic.modeLabel,
        sampleActive,
        animate: traffic.animate,
        showPlaceholder: metricsByNode.size === 0 && !sampleActive,
      };
      return {
        ...node,
        selected: selection?.type === 'node' && selection.id === node.id,
        data: { ...node.data, traffic: nodeView },
      };
    });
  }, [
    evidence,
    graph,
    metricsByNode,
    selection,
    traffic.animate,
    traffic.frame,
    traffic.modeLabel,
    trafficNodesById,
  ]);

  const edges = useMemo(() => {
    const mapped = toCanvasEdges(graph);
    return mapped.map((edge) => {
      const trafficView: TrafficEdgeView | null = buildTrafficEdgeView({
        edge: trafficEdgesById.get(edge.id) ?? null,
        frame: traffic.frame,
        modeLabel: traffic.modeLabel,
        animate: traffic.animate,
        reducedMotion: traffic.reducedMotion,
      });
      return {
        ...edge,
        selected: selection?.type === 'edge' && selection.id === edge.id,
        data: {
          ...(edge.data ?? {}),
          traffic: trafficView,
        } as CanvasEdge['data'],
      };
    });
  }, [
    graph,
    selection,
    traffic.animate,
    traffic.frame,
    traffic.modeLabel,
    traffic.reducedMotion,
    trafficEdgesById,
  ]);

  const onNodesChange = useCallback<OnNodesChange<CanvasNode>>(
    (changes) => {
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          moveNode(change.id, change.position);
        }
      }
    },
    [moveNode],
  );

  const onNodeDragStart = useCallback(() => beginMove(), [beginMove]);

  const onNodeDragStop = useCallback(
    (_event: unknown, node: CanvasNode) => {
      moveNode(node.id, node.position);
      endMove();
    },
    [endMove, moveNode],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (locked) {
        setConnectionError('The graph is frozen until the run ends.');
        return;
      }
      const port = connection.sourceHandle;
      if (!port || !VALID_PORTS.has(port as EdgeSourcePort)) {
        setConnectionError('No source port was selected.');
        return;
      }
      const result = addEdge(
        connection.source,
        port as EdgeSourcePort,
        connection.target,
      );
      setConnectionError(
        result.ok
          ? null
          : (result.issues?.[0]
              ? result.issues[0].message
              : (result.message ?? 'Connection rejected')),
      );
    },
    [addEdge, locked],
  );

  const onNodeClick = useCallback(
    (_event: unknown, node: CanvasNode) => {
      select({ type: 'node', id: node.id });
      onSelected?.();
    },
    [onSelected, select],
  );

  const onEdgeClick = useCallback(
    (_event: unknown, edge: CanvasEdge) => {
      select({ type: 'edge', id: edge.id });
      onSelected?.();
    },
    [onSelected, select],
  );

  return (
    <div className="canvas-shell">
      <ReactFlow<CanvasNode, CanvasEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
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
        connectionLineStyle={{ stroke: '#0e7490', strokeWidth: 2 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="#c9d8e5" />
      </ReactFlow>
      <CanvasZoomControls />
      <TrafficStatusBadge view={traffic} />
      {evidence.stale ? (
        <div className="canvas-stale" role="status">
          Previous run — the graph or settings changed. Metrics and failure
          highlights are hidden until you run again.
        </div>
      ) : null}
      {locked ? (
        <div className="canvas-lock" role="status">
          Graph frozen · you can still move and select components
        </div>
      ) : null}
      {connectionError ? (
        <div className="canvas-alert" role="alert">
          <span>{connectionError}</span>
          <button type="button" onClick={() => setConnectionError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function EditorCanvas(props: {
  graph: GraphDocument;
  selection: EditorSelection;
  locked: boolean;
  snapshot: SimulationSnapshot | null;
  evidence: CanvasEvidence;
  suppressAutoFit?: boolean;
  onSelected?: () => void;
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
