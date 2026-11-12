import { Boxes } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  CART_EDGE_KINDS,
  isCartQualificationIssue,
  isCartStructuralIssue,
  validateCartGraph,
  type CartIssue,
} from '../index';
import { Button } from '../../ui/Button';
import { TelemetryResizer } from '../../features/shell/TelemetryResizer';
import { Modal } from '../../ui/Modal';
import { StatusPill } from '../../ui/StatusPill';
import { SidePanel, WorkspaceLayout, WorkspaceToolbar, TelemetryPanel } from '../../features/game-ui';
import { useMediaQuery } from '../../ui/use-media-query';
import { CartBriefing } from './CartBriefing';
import { CartCanvas } from './CartCanvas';
import { CartConnectDialog } from './CartConnectDialog';
import { CartInspector } from './CartInspector';
import { CartPalette } from './CartPalette';
import { canSource, canTarget, type CartConnectRequest } from './cart-meta';
import type { CartHotspots } from './cart-hotspots';
import { useCartStore } from './cart-store';
import './cart.css';

type LeftTab = 'task' | 'build';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
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

function uniqueIssues(issues: CartIssue[]): CartIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}|${issue.message}|${issue.nodeId ?? ''}|${issue.edgeId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function CartWorkspace({runControls, telemetry, onExport = () => {}, onCopyLink, onImport = () => {}, resultsAction, revealNonce = 0, telemetryActive, runActive, hotspots}: {
  runControls?: ReactNode; telemetry?: ReactNode; onExport?: () => void; onCopyLink?: () => void; onImport?: () => void; resultsAction?: ReactNode; revealNonce?: number;
  /** True once a run has started or a result exists; the telemetry panel stays collapsed until then. */
  telemetryActive?: boolean;
  /** True while a run is advancing (not paused); the canvas shows traffic moving along paths. */
  runActive?: boolean;
  /** Measured overload from the last result, shown on the affected components and paths. */
  hotspots?: CartHotspots;
}) {
  const splitRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [telemetryOpen, setTelemetryOpen] = useState(false);
  const [telemetryHeight, setTelemetryHeight] = useState(280);
  const graph = useCartStore((state) => state.graph);
  const selection = useCartStore((state) => state.selection);
  const past = useCartStore((state) => state.past);
  const future = useCartStore((state) => state.future);
  const undo = useCartStore((state) => state.undo);
  const redo = useCartStore((state) => state.redo);
  const resetGraph = useCartStore((state) => state.resetGraph);
  const removeNode = useCartStore((state) => state.removeNode);
  const removeEdge = useCartStore((state) => state.removeEdge);
  const clearSelection = useCartStore((state) => state.clearSelection);

  const compact = useMediaQuery('(max-width: 1360px)');
  const [leftTab, setLeftTab] = useState<LeftTab>('task');
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectRequest, setConnectRequest] = useState<
    CartConnectRequest | undefined
  >(undefined);
  const [resetOpen, setResetOpen] = useState(false);
  // Each message is a new object, so repeating the same text still restarts the auto-dismiss timer.
  const [flash, setFlash] = useState<{ text: string } | null>(null);

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 4000);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const issues = useMemo(() => uniqueIssues(validateCartGraph(graph)), [graph]);
  const structural = issues.filter(isCartStructuralIssue).length;
  const qualification = issues.filter(isCartQualificationIssue).length;
  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  // A blocked Run can open the named component's Properties directly. This is
  // derived from a prop change during render, not an effect, so the panel opens
  // in the same commit as the selection.
  const [seenReveal, setSeenReveal] = useState(revealNonce);
  if (revealNonce !== seenReveal) {
    setSeenReveal(revealNonce);
    if (selection?.type === 'node' && !rightOpen) setRightOpen(true);
  }

  // Telemetry starts collapsed and opens once when a run starts; the user can still toggle it.
  const isTelemetryActive = telemetryActive === true;
  const [seenTelemetryActive, setSeenTelemetryActive] = useState(false);
  if (isTelemetryActive !== seenTelemetryActive) {
    setSeenTelemetryActive(isTelemetryActive);
    if (isTelemetryActive) setTelemetryOpen(true);
  }

  const openConnect = useCallback((request?: CartConnectRequest) => {
    if (request?.from && request.to) {
      const state = useCartStore.getState();
      const source = state.graph.nodes.find((node) => node.id === request.from);
      const target = state.graph.nodes.find((node) => node.id === request.to);
      const kinds = source && target ? CART_EDGE_KINDS.filter((kind) =>
        canSource(source, kind) && canTarget(source, target, kind),
      ) : [];
      // A canvas drop never opens the dialog: an unambiguous or ambiguous pair
      // is created at once, preferring the 'request' meaning when it applies.
      const chosen = kinds.includes('request') ? 'request' : kinds[0];
      if (chosen) {
        const result = state.addEdge(request.from, request.to, chosen);
        setFlash({ text: result.message ?? (result.ok ? 'Path added.' : 'Connection rejected.') });
        return;
      }
      setFlash({ text: 'These components cannot connect in this direction.' });
      return;
    }
    setConnectRequest(request);
    setConnectOpen(true);
  }, []);

  const openBuild = useCallback(() => {
    setLeftTab('build');
    setLeftOpen(true);
    setRightOpen(false);
  }, []);

  const handleDeleteSelection = useCallback(() => {
    if (!selection) return;
    const result =
      selection.type === 'node'
        ? removeNode(selection.id)
        : removeEdge(selection.id);
    setFlash({ text: result.ok ? 'Selection deleted.' : (result.message ?? 'Could not delete.') });
  }, [removeEdge, removeNode, selection]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (connectOpen || resetOpen || isInsideDialog(event.target)) return;
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (event.key === 'Escape') {
        if (compact && (leftOpen || rightOpen)) {
          setLeftOpen(false);
          setRightOpen(false);
          return;
        }
        if (selection) clearSelection();
        return;
      }
      if (
        !modifier &&
        !event.altKey &&
        event.key.toLowerCase() === 'c'
      ) {
        event.preventDefault();
        openConnect();
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
    compact,
    connectOpen,
    handleDeleteSelection,
    leftOpen,
    openConnect,
    redo,
    resetOpen,
    rightOpen,
    selection,
    undo,
  ]);

  return (
    <>
      <WorkspaceLayout
        className="cart-workspace"
        variant="collapsible"
        leftOpen={leftOpen}
        modalInspector={false}
        rightOpen={rightOpen}
        compact={compact}
        onClosePanels={() => {
          setLeftOpen(false);
          setRightOpen(false);
        }}
        leftPanel={
          <SidePanel
            side="left"
            label={leftTab === 'task' ? 'Task' : 'Build'}
            open={leftOpen}
            onClose={() => setLeftOpen(false)}

          >
            {leftTab === 'task' ? (
              <>
                <StatusPill tone={structural ? 'danger' : qualification ? 'warning' : 'success'}>
                  {structural ? `${structural} blocking issues` : qualification ? `${qualification} missing requirements` : 'Graph structurally valid'}
                </StatusPill><CartBriefing /></>
            ) : (
              <CartPalette onOpenConnect={() => openConnect()} />
            )}
          </SidePanel>
        }
        rightPanel={
          <SidePanel
            side="right"
            label="Cart inspector"
            open={rightOpen}
            onClose={() => setRightOpen(false)}
          >
            <CartInspector graph={graph} selection={selection} issues={issues} />
          </SidePanel>
        }
        toolbar={
          <>
            {runControls}
            <WorkspaceToolbar leftOpen={leftOpen && leftTab === 'task'} rightOpen={rightOpen}
              onToggleLeft={() => {setLeftTab('task'); setLeftOpen(!(leftOpen && leftTab === 'task')); setRightOpen(false);}}
              taskActions={<Button variant="ghost" size="sm" icon={<Boxes size={15} />}
                aria-expanded={leftOpen && leftTab === 'build'}
                onClick={() => {setLeftTab('build'); setLeftOpen(!(leftOpen && leftTab === 'build')); setRightOpen(false);}}>
                Build
              </Button>}
              onToggleRight={() => {setRightOpen(!rightOpen); setLeftOpen(false);}}
              canUndo={canUndo} canRedo={canRedo} onUndo={undo} onRedo={redo}
              locked={false} onConnect={() => openConnect()} onExport={onExport} onCopyLink={onCopyLink} onImport={onImport}
              onReset={() => setResetOpen(true)} panelToggles="always" rightActions={resultsAction} />
          </>
        }
        splitRef={splitRef}
        resizer={telemetryOpen ? <TelemetryResizer containerRef={splitRef} panelRef={panelRef}
          height={telemetryHeight} onChange={setTelemetryHeight} onCommit={setTelemetryHeight} /> : null}
        telemetry={<TelemetryPanel title="Telemetry" summary="Global Cart" open={telemetryOpen}
          onOpenChange={setTelemetryOpen} height={telemetryHeight} panelRef={panelRef}
          bodyId="cart-telemetry-body" ariaLabel="Global Cart telemetry">
          {telemetry ?? <p>Run the design to see measured traffic, latency and qualification results.</p>}
        </TelemetryPanel>}
        canvas={
          <CartCanvas
            graph={graph}
            selection={selection}
            issues={issues}
            onInspectNode={() => { setRightOpen(true); setLeftOpen(false); }}
            onConnectRequest={(request) => openConnect(request)}
            onOpenBuild={openBuild}
            runActive={runActive}
            hotspots={hotspots}
          />
        }
      />

      {flash ? (
        <p
          className="cart-flash"
          role="status"
          title="Click to dismiss"
          onClick={() => setFlash(null)}
        >
          {flash.text}
        </p>
      ) : null}

      {connectOpen ? (
        <CartConnectDialog
          graph={graph}
          initial={connectRequest}
          onClose={() => {
            setConnectOpen(false);
            setConnectRequest(undefined);
          }}
        />
      ) : null}

      {resetOpen ? (
        <Modal title="Reset the design?" onClose={() => setResetOpen(false)}>
          <p>
            Reset replaces the current design with the exact starter: three fixed
            customer sources, no services, no paths and no circuits. This is not
            automatic saving or restoring.
          </p>
          <div className="cart-reset__actions">
            <Button
              variant="danger"
              onClick={() => {
                resetGraph();
                setResetOpen(false);
                setFlash({ text: 'Design reset to the source-only starter.' });
              }}
            >
              Reset design
            </Button>
            <Button variant="ghost" onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
