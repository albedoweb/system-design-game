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
  type FinalConnectionState,
  type NodeProps,
  type NodeTypes,
  type OnNodesChange,
} from '@xyflow/react';
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { CartGraph, CartIssue } from '../index';
import { CartEdge, type CartEdgeFlowData, type CartEdgeFlowEdge } from './CartEdge';
import { CartNode, type CartNodeFlowData, type CartNodeFlowNode } from './CartNode';
import {
  CART_CIRCUIT_PAIRS,
  CART_EDGE_UI,
  CART_REGION_ORDER,
  cartCircuitKey,
  cartCircuitShortLabel,
  cartNodeDisplayName,
  cartNodeSummary,
  cartRegionShort,
  type CartConnectRequest,
  type CartFlowLane,
} from './cart-meta';
import type { CartHotspots } from './cart-hotspots';
import { useCartStore, type CartSelection } from './cart-store';

function CartLane({ data }: NodeProps<CartFlowLane>) {
  return (
    <div className={`cart-lane cart-lane--${data.region}`} aria-hidden="true">
      <div className="cart-lane__head">
        <span className="cart-lane__chip">{cartRegionShort(data.region)}</span>
        <span className="cart-lane__count">
          {data.nodeCount} component{data.nodeCount === 1 ? '' : 's'}
        </span>
      </div>
      <p className="cart-lane__circuits">{data.circuits}</p>
      {(data.hotNotes ?? []).map((note) => (
        <p className="cart-lane__hot" key={note}>
          {note}
        </p>
      ))}
    </div>
  );
}

/** Fit never zooms the graph below this, so text stays readable; the player pans for the rest. */
const FIT_OPTIONS = { minZoom: 0.7, maxZoom: 1.1 } as const;

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

const nodeTypes = {
  'cart-node': CartNode,
  'cart-lane': CartLane,
} satisfies NodeTypes;

const edgeTypes = { 'cart-edge': CartEdge } satisfies EdgeTypes;

function CanvasZoomControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <Panel position="top-right" className="cart-canvas__zoom">
      <div role="toolbar" aria-label="Canvas zoom">
        <button type="button" onClick={() => zoomOut()} aria-label="Zoom out">
          <ZoomOut size={16} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => zoomIn()} aria-label="Zoom in">
          <ZoomIn size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => void fitView({ padding: 0.18, duration: 180, ...FIT_OPTIONS })}
          aria-label="Fit graph to canvas"
        >
          <Maximize2 size={16} aria-hidden="true" />
        </button>
      </div>
    </Panel>
  );
}

function CanvasInner({
  graph,
  selection,
  issues,
  onConnectRequest,
  onInspectNode,
  onOpenBuild,
  runActive,
  hotspots,
}: {
  graph: CartGraph;
  selection: CartSelection;
  issues: CartIssue[];
  onConnectRequest: (request: CartConnectRequest) => void;
  onInspectNode?: () => void;
  onOpenBuild?: () => void;
  runActive?: boolean;
  hotspots?: CartHotspots;
}) {
  const moveNode = useCartStore((state) => state.moveNode);
  const endMove = useCartStore((state) => state.endMove);
  const select = useCartStore((state) => state.select);
  const clearSelection = useCartStore((state) => state.clearSelection);
  const { fitView } = useReactFlow();
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);
  const nodeCountRef = useRef(graph.nodes.length);
  // True when onConnect already created the path for the current drag.
  const connectHandledRef = useRef(false);

  useEffect(() => {
    if (canvasWidth === 0 || canvasHeight === 0) return;
    const frame = requestAnimationFrame(() => {
      void fitView({ padding: 0.16, duration: 150, ...FIT_OPTIONS });
    });
    return () => cancelAnimationFrame(frame);
  }, [canvasHeight, canvasWidth, fitView]);

  useEffect(() => {
    if (nodeCountRef.current === graph.nodes.length) return;
    nodeCountRef.current = graph.nodes.length;
    void fitView({ padding: 0.16, duration: 180, ...FIT_OPTIONS });
  }, [fitView, graph.nodes.length]);

  const issuesByNode = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of issues) {
      if (!issue.nodeId) continue;
      counts.set(issue.nodeId, (counts.get(issue.nodeId) ?? 0) + 1);
    }
    return counts;
  }, [issues]);

  const nodes = useMemo(() => {
    // Lanes grow only as far as the lowest component needs, so a fresh design is not a 790px-tall field.
    const lowestY = graph.nodes.reduce((max, node) => Math.max(max, node.position.y), 0);
    const highestY = graph.nodes.reduce((min, node) => Math.min(min, node.position.y), Number.POSITIVE_INFINITY);
    const hotNotesFor = (region: (typeof CART_REGION_ORDER)[number]): string[] =>
      CART_CIRCUIT_PAIRS.filter((pair) => pair.includes(region)).flatMap(([a, b]) => {
        const label = hotspots?.circuits[cartCircuitKey(a, b)];
        return label ? [`Circuit to ${cartRegionShort(a === region ? b : a)}: ${label}`] : [];
      });
    const mostNotes = Math.max(0, ...CART_REGION_ORDER.map((region) => hotNotesFor(region).length));
    // The lane header (title, circuits line, overload notes) must sit above the topmost card.
    const headerHeight = 58 + mostNotes * 20;
    const laneTop = Math.min(18, (Number.isFinite(highestY) ? highestY : 76) - headerHeight);
    const laneHeight = Math.max(420, lowestY + 220) - laneTop + 18;
    const laneNodes: CartFlowLane[] = CART_REGION_ORDER.map((region) => {
      const pairs = CART_CIRCUIT_PAIRS.filter((pair) => pair.includes(region))
        .map(
          ([a, b]) =>
            `${cartRegionShort(a === region ? b : a)} ${cartCircuitShortLabel(graph, a, b)}`,
        )
        .join(' · ');
      return {
        id: `lane-${region}`,
        type: 'cart-lane',
        position: { x: 40 + CART_REGION_ORDER.indexOf(region) * 400, y: laneTop },
        data: {
          region,
          nodeCount: graph.nodes.filter((node) => node.region === region && node.kind !== 'customers').length,
          circuits: pairs,
          hotNotes: hotNotesFor(region),
        },
        draggable: false,
        selectable: false,
        connectable: false,
        focusable: false,
        zIndex: -1,
        style: { width: 340, height: laneHeight },
      };
    });
    const cartNodes: CartNodeFlowNode[] = graph.nodes.map((node) => {
      const data: CartNodeFlowData = {
        node,
        issueCount: issuesByNode.get(node.id) ?? 0,
        summary: cartNodeSummary(node, graph),
        hot: hotspots?.nodes[node.id],
      };
      return {
        id: node.id,
        type: 'cart-node',
        position: node.position,
        data,
        selected: selection?.type === 'node' && selection.id === node.id,
        zIndex: 1,
      };
    });
    return [...laneNodes, ...cartNodes];
  }, [graph, hotspots, issuesByNode, selection]);

  const edges = useMemo<CartEdgeFlowEdge[]>(() => {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    return graph.edges.map((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      const crossRegion = from !== undefined && to !== undefined && from.region !== to.region;
      // Only a path between the two regions of a hot circuit is hot.
      const hot =
        from && to && crossRegion
          ? hotspots?.circuits[cartCircuitKey(from.region, to.region)]
          : undefined;
      const className = [runActive ? 'is-flowing' : '', hot ? 'is-hot' : '']
        .filter(Boolean)
        .join(' ');
      const data: CartEdgeFlowData = {
        edge,
        fromLabel: from ? cartNodeDisplayName(from) : edge.from,
        toLabel: to ? cartNodeDisplayName(to) : edge.to,
        crossRegion,
        roles: edge.kind === 'request' && from?.kind === 'application' && to && ['journal', 'store', 'application'].includes(to.kind)
          ? [from.readTargets.includes(edge.to) ? 'Read' : '', from.writeTarget === edge.to ? 'Write' : ''].filter(Boolean).join(' + ') || 'Request path (unassigned)'
          : undefined,
        circuit:
          from && to
            ? cartCircuitShortLabel(graph, from.region, to.region)
            : 'no circuit',
        flowing: runActive === true,
        hot,
      };
      return {
        id: edge.id,
        type: 'cart-edge',
        className: className || undefined,
        source: edge.from,
        target: edge.to,
        sourceHandle: 'out',
        targetHandle: 'in',
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: CART_EDGE_UI[edge.kind].color,
          width: 18,
          height: 18,
        },
        selected: selection?.type === 'edge' && selection.id === edge.id,
        data,
      };
    });
  }, [graph, hotspots, runActive, selection]);

  const onNodesChange = useCallback<OnNodesChange<CartNodeFlowNode | CartFlowLane>>(
    (changes) => {
      for (const change of changes) {
        if (change.type !== 'position' || !change.position) continue;
        if (change.id.startsWith('lane-')) continue;
        moveNode(change.id, change.position);
      }
    },
    [moveNode],
  );

  const onConnectStart = useCallback(() => {
    connectHandledRef.current = false;
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      connectHandledRef.current = true;
      onConnectRequest({ from: connection.source, to: connection.target });
    },
    [onConnectRequest],
  );

  // A drag dropped on a target node's body (not its small handle) also creates the path.
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      const handled = connectHandledRef.current;
      connectHandledRef.current = false;
      if (handled || connectionState.isValid === true) return;
      const sourceId = connectionState.fromNode?.id;
      if (!sourceId) return;
      let targetId = connectionState.toNode?.id;
      if (!targetId) {
        const pointer = 'changedTouches' in event ? event.changedTouches[0] : event;
        if (!pointer) return;
        const element = document.elementFromPoint(pointer.clientX, pointer.clientY);
        targetId = element?.closest<HTMLElement>('.react-flow__node')?.dataset.id;
      }
      if (!targetId || targetId === sourceId || targetId.startsWith('lane-')) return;
      onConnectRequest({ from: sourceId, to: targetId });
    },
    [onConnectRequest],
  );

  const onlyFixedSources = graph.nodes.every((node) => node.kind === 'customers');

  return (
    <ReactFlow<CartNodeFlowNode | CartFlowLane, CartEdgeFlowEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStop={(_event, node) => {
        moveNode(node.id, node.position);
        endMove();
      }}
      onConnect={onConnect}
      onConnectStart={onConnectStart}
      onConnectEnd={onConnectEnd}
      onNodeClick={(_event, node) => {
        if (node.type === 'cart-node') {
          select({ type: 'node', id: node.id });
          onInspectNode?.();
        }
      }}
      onEdgeClick={(_event, edge) => {
        select({ type: 'edge', id: edge.id });
        onInspectNode?.();
      }}
      onPaneClick={() => clearSelection()}
      nodesConnectable
      nodesDraggable
      nodesFocusable
      edgesFocusable
      edgesReconnectable={false}
      elementsSelectable
      deleteKeyCode={null}
      multiSelectionKeyCode={null}
      minZoom={0.3}
      maxZoom={1.5}
      snapToGrid
      snapGrid={[10, 10]}
      connectionRadius={60}
      connectionLineStyle={{ stroke: 'var(--accent)', strokeWidth: 2 }}
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={22}
        size={1}
        color="#e4e4e7"
      />
      <CanvasZoomControls />
      <Panel position="bottom-left" className="cart-canvas__legend">
        <ul>
          {(Object.keys(CART_EDGE_UI) as Array<keyof typeof CART_EDGE_UI>).map(
            (kind) => (
              <li key={kind}>
                <span
                  className={`cart-canvas__swatch cart-canvas__swatch--${kind}`}
                  aria-hidden="true"
                />
                {CART_EDGE_UI[kind].label}
              </li>
            ),
          )}
        </ul>
      </Panel>
      <Panel position="top-left" className="cart-canvas__counts">
        <span>{countLabel(graph.nodes.filter((node) => node.kind !== 'customers').length, 'component')}</span>
        <span>{countLabel(graph.edges.length, 'path')}</span>
        <span>{countLabel(graph.circuits.length, 'circuit')}</span>
      </Panel>
      {onlyFixedSources ? (
        <Panel position="top-center" className="cart-canvas__start">
          <p>Start here: add an Application in each region, then storage and one Inventory.</p>
          {onOpenBuild ? (
            <button type="button" onClick={onOpenBuild}>
              Open Build
            </button>
          ) : null}
        </Panel>
      ) : null}
    </ReactFlow>
  );
}

export function CartCanvas(props: {
  graph: CartGraph;
  selection: CartSelection;
  issues: CartIssue[];
  onConnectRequest: (request: CartConnectRequest) => void;
  onInspectNode?: () => void;
  onOpenBuild?: () => void;
  /** True while a run is advancing (not paused): traffic moves along the paths. */
  runActive?: boolean;
  /** Measured overload from the last result, shown on components and circuits. */
  hotspots?: CartHotspots;
}) {
  return (
    <div className={props.runActive ? 'cart-canvas is-running' : 'cart-canvas'}>
      <ReactFlowProvider>
        <CanvasInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}
