import { useEffect, useMemo, useRef, useState } from 'react';

import { CART_MAX_SEED, CART_LIMITS, CART_VERSIONS, CART_REQUIRED_CASES, type CartCaseId, type CartCaseTelemetry, type CartEvaluation, type CartIssue, type CartTrafficFrame } from '../index';
import { NumberField } from '../../ui/NumberField';
import { Button } from '../../ui/Button';
import { Modal } from '../../ui/Modal';
import { CartWorkspace } from './CartWorkspace';
import { CartReplayControl } from './CartReplayControl';
import { CartResultsPanel } from './CartResultsPanel';
import { cartCaseLabel, cartRankingEligible } from './cart-diagnostics';
import { cartHotspots } from './cart-hotspots';
import { cartIssueText } from './cart-issue-text';
import { createCartRunController } from './cart-run-controller';
import { downloadCartState, parseCartState, serializeCartState } from './cart-persistence';
import { buildCartShareUrl, loadCartShareData, readCartShareData } from './cart-share-link';
import { useCartStore } from './cart-store';
import './cart-header.css';

/** Instance-local run state; editing, reset, import and unmount invalidate the worker. */
export function CartHeader() {
  const graph = useCartStore((state) => state.graph);
  const [controller] = useState(() => createCartRunController({ cancelGraceMs: 10_000, progressIntervalMs: 0 }));
  const advancePending = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [running, setRunning] = useState(false);
  const [requestProblems, setRequestProblems] = useState(0);
  const [completedCases, setCompletedCases] = useState(0);
  const [caseProgress, setCaseProgress] = useState<{ current: number; total: number } | null>(null);
  const [paused, setPaused] = useState(false);
  const [evaluation, setEvaluation] = useState<CartEvaluation | null>(null);
  const [telemetry, setTelemetry] = useState<Partial<Record<CartCaseId, CartCaseTelemetry>>>({});
  const [frames, setFrames] = useState<Partial<Record<CartCaseId, CartTrafficFrame[]>>>({});
  const [caseId, setCaseId] = useState<CartCaseId>(CART_REQUIRED_CASES[0]);
  const [message, setMessage] = useState('Ready to run');
  const [resultsOpen, setResultsOpen] = useState(false);
  const [blocked, setBlocked] = useState<CartIssue[]>([]);
  const [runError, setRunError] = useState(false);
  const [reveal, setReveal] = useState(0);
  const hotspots = useMemo(() => cartHotspots(graph, evaluation), [graph, evaluation]);
  /** Status of the run, used only for styling; the status text itself is unchanged. */
  const runStatus = blocked.length > 0 || runError ? 'blocked'
    : running ? (paused ? 'paused' : 'running')
      : evaluation ? (evaluation.complete ? 'done' : 'incomplete') : 'idle';
  /** Outcome of the finished evaluation, for the verdict card colour. */
  const verdictTone = evaluation === null || !evaluation.complete ? 'partial'
    : cartRankingEligible(evaluation) ? 'pass' : 'fail';
  const importGeneration = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Set only when the clipboard is unavailable, so the player can copy the link by hand. */
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  // Open a design link once per page load. Loading goes through the same
  // parseCartState validation as Import; the fragment is removed afterwards.
  useEffect(() => {
    const data = readCartShareData(window.location.hash);
    if (data === null) return;
    let cancelled = false;
    const generation = ++importGeneration.current;
    void (async () => {
      const outcome = await loadCartShareData(data, () => generation === importGeneration.current);
      // An unmounted or StrictMode-superseded run leaves the work to the run that is still current.
      if (cancelled) return;
      // Every outcome that reaches this point removes the fragment and reports a message.
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      if (outcome.kind === 'loaded') {
        useCartStore.getState().replaceGraph(outcome.graph);
        setMessage('Design loaded from link. Ready to run');
      } else if (outcome.kind === 'failed') {
        setMessage(outcome.message);
      } else {
        setMessage('The design from the link was not loaded because the editor was changed while it was opening. Open the link again to load it.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const unsubscribe = useCartStore.subscribe((state, previous) => {
      if (state.graph === previous.graph) return;
      importGeneration.current += 1;
      controller.dispose();
      setRunning(false);
      setPaused(false);
      setEvaluation(null);
      setTelemetry({});
      setFrames({});
      setResultsOpen(false);
      setBlocked([]);
      setMessage('Design changed. Ready to run');
    });
    return () => {
      importGeneration.current += 1;
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    if (!running || paused || stopping) return;
    const timer = window.setInterval(() => {
      if (advancePending.current) return;
      advancePending.current = controller.advance(1000);
    }, 20);
    return () => window.clearInterval(timer);
  }, [controller, running, paused, stopping]);

  const run = () => {
    if (graph.nodes.every((node) => node.kind === 'customers')) {
      setMessage('Nothing to run yet. Open Build and add an Application in each region.');
      return;
    }
    setStopping(false);
    advancePending.current = true;
    setEvaluation(null);
    setTelemetry({});
    setFrames({});
    setPaused(false);
    setBlocked([]);
    setRunError(false);
    setRequestProblems(0);
    setCompletedCases(0);
    setCaseProgress(null);
    setMessage(`Running ${cartCaseLabel('normal')}, then ${cartCaseLabel('peak')}`);
    let wasBlocked = false;
    const token = controller.start({ graph, seed: graph.seed, autoplay: false, telemetry: { maxFrames: 240, maxTraceEvents: 200 } }, {
      onBlocked: (issues) => {
        wasBlocked = true;
        setBlocked([...issues]);
        setMessage('Cannot run yet — see the list below.');
      },
      onProgress: (progress) => {
        advancePending.current = false;
        setCompletedCases(progress.casesCompleted);
        setRequestProblems(progress.requestProblems ?? 0);
        setCaseProgress(progress.caseEvents !== undefined && progress.caseEventsTotal !== undefined
          ? { current: progress.caseEvents, total: progress.caseEventsTotal } : null);
        setMessage(progress.caseId ? `Running: ${cartCaseLabel(progress.caseId)}` : progress.casesCompleted ? 'Finishing run' : 'Preparing run');
      },
      onFrame: (frame) => setFrames((current) => ({
        ...current, [frame.caseId]: [...(current[frame.caseId] ?? []), frame].slice(-240),
      })),
      onTelemetry: (snapshot) => setTelemetry((current) => ({ ...current, [snapshot.caseId]: snapshot })),
      onResult: (result) => {
        setEvaluation(result);
        setRunning(false);
        setMessage(result.complete ? 'Run complete' : 'Run incomplete');
        setResultsOpen(true);
      },
      onCancelled: (partial) => {
        setStopping(false);
        setRunning(false);
        setEvaluation(partial);
        setResultsOpen(partial !== null);
        setMessage(partial ? 'Run stopped — partial report available. No final score.' : 'Run stopped. Partial report unavailable.');
      },
      onError: (error) => {
        setRunning(false);
        setRunError(!wasBlocked);
        setMessage(wasBlocked ? 'Cannot run yet — see the list below.' : error);
      },
    });
    setRunning(token !== null);
  };

  const exportDesign = () => {
    try { downloadCartState(graph); setMessage('Design exported.'); }
    catch { setMessage('Could not export the design.'); }
  };
  /** Builds the link only on this explicit press; nothing updates the address bar while editing. */
  const copyLink = async () => {
    let exported: string;
    try { exported = serializeCartState(graph); }
    catch { setMessage('Could not copy the link.'); return; }
    const built = await buildCartShareUrl(`${window.location.origin}${window.location.pathname}${window.location.search}`, exported);
    if (!built.ok) { setMessage(built.message); return; }
    try {
      await navigator.clipboard.writeText(built.url);
      setMessage('Design link copied to the clipboard.');
    } catch {
      setShareUrl(built.url);
    }
  };
  return (
    <>
      <CartWorkspace onExport={exportDesign} onCopyLink={() => { void copyLink(); }} onImport={() => fileInputRef.current?.click()}
        runActive={running && !paused && !stopping} hotspots={hotspots}
        resultsAction={<Button disabled={!evaluation} onClick={() => setResultsOpen(true)}>Results</Button>}
        runControls={<>
      <div className="cart-toolbar" role="toolbar" aria-label="Global Cart run and files">
        <h1 className="cart-toolbar__title">Global Cart</h1>
        <div className="cart-toolbar__controls">
          <div className="cart-toolbar__seed" title="Changes the traffic sequence, keeps your design, and clears previous run results.">
            <NumberField label="Seed" value={graph.seed} min={0} max={CART_MAX_SEED}
              onCommit={(seed) => useCartStore.getState().setSeed(seed)} />
          </div>
          <Button variant="primary" onClick={run} disabled={running}>Run</Button>
          <Button disabled={!running} onClick={() => setPaused((value) => !value)}>{paused ? 'Resume' : 'Pause'}</Button>
          <Button disabled={!running || stopping} onClick={() => { setStopping(true); controller.cancel(); }}>{stopping ? 'Stopping…' : 'Stop & inspect'}</Button>
        </div>
        <label hidden>
          Import
          <input ref={fileInputRef} type="file" accept=".json,application/json" aria-label="Open saved Global Cart design file" onChange={async (event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (!file) return;
            const generation = ++importGeneration.current;
            if (file.size > CART_LIMITS.maxDocumentBytes) {
              setMessage('The design file is too large. The design was not changed.');
              return;
            }
            try {
              const parsed = parseCartState(await file.text());
              if (generation !== importGeneration.current) return;
              if (!parsed.ok) {
                setMessage('Invalid or unsupported Global Cart design file. The design was not changed.');
                return;
              }
              useCartStore.getState().replaceGraph(parsed.graph);
              setMessage(
                parsed.migratedFrom === undefined
                  ? 'Design imported. Ready to run'
                  : `Design imported from ${parsed.migratedFrom} and updated to the Cart Foundations content (${CART_VERSIONS.content}). Ready to run`,
              );
            } catch {
              if (generation === importGeneration.current) setMessage('Could not read the file. The design was not changed.');
            }
          }} />
        </label>
        <span role="status" className="cart-run-status" data-state={runStatus}>{paused ? 'Paused' : message}</span>
        {running && requestProblems > 0 && <p className="cart-run-warning" role="status">
          {requestProblems.toLocaleString()} request problems observed (errors, rejections or timeouts). Run still in progress — stop to inspect.
        </p>}
        {running && <div className={`cart-run-progress${paused ? ' is-paused' : ''}`}>
          <span>{completedCases} / {CART_REQUIRED_CASES.length} scenarios completed · {caseProgress ? `${caseProgress.current.toLocaleString()} / ${caseProgress.total.toLocaleString()} requests started in this scenario` : 'Preparing scenario'}</span>
          <div className="cart-run-progress__track" role="progressbar" aria-label="Evaluation progress" aria-valuemin={0} aria-valuemax={caseProgress?.total ?? 1} aria-valuenow={caseProgress?.current ?? 0} aria-valuetext={caseProgress ? `${caseProgress.current} of ${caseProgress.total} requests started${paused ? ', paused' : ''}` : 'Preparing scenario'}><i style={caseProgress ? { width: `${100 * caseProgress.current / Math.max(1, caseProgress.total)}%`, animation: 'none' } : undefined} /></div>
        </div>}
        {blocked.length > 0 ? (
          <div className="cart-run-blocked" role="alert">
            <strong>This design cannot run yet.</strong>
            <ul>
              {blocked.slice(0, 4).map((issue, index) => (
                <li key={`${issue.code}-${issue.nodeId ?? issue.edgeId ?? index}`}>
                  <span>{cartIssueText(graph, issue)}</span>
                  {issue.nodeId ? (
                    <Button variant="ghost" size="sm" onClick={() => {
                      useCartStore.getState().select({ type: 'node', id: issue.nodeId as string });
                      setReveal((value) => value + 1);
                    }}>Open Properties</Button>
                  ) : null}
                </li>
              ))}
            </ul>
            {blocked.length > 4 ? <p>{blocked.length - 4} more shown under Properties.</p> : null}
          </div>
        ) : null}
      </div>
      </>}
      revealNonce={reveal}
      telemetryActive={running || evaluation !== null || Object.values(frames).some((items) => items.length > 0)}
      telemetry={<div>
      {!Object.values(frames).some((items) => items.length > 0) && !evaluation ? <p>Run the design to see measured traffic and latency. Open Task for requirements and scoring criteria.</p> : null}
      {Object.values(frames).some((items) => items.length > 0) ? (
        <div>
          <label className="cart-replay-case">Scenario <select className="ui-input" aria-label="Scenario" value={caseId} onChange={(event) => setCaseId(event.target.value as CartCaseId)}>
            {CART_REQUIRED_CASES.map((id) => <option key={id} value={id}>{cartCaseLabel(id)}</option>)}
          </select></label>
          <CartReplayControl key={caseId} frames={frames[caseId] ?? []} caseLabel={cartCaseLabel(caseId)} />
        </div>
      ) : null}
      {evaluation ? (
        <div className={`cart-results-summary cart-results-summary--${verdictTone}`}>
          <p>{!evaluation.complete
            ? 'Stopped early — partial measurements only, no score.'
            : cartRankingEligible(evaluation)
              ? 'Passed — both scenarios meet every requirement.'
              : 'Not passed — open the results to see which checks failed.'}</p>
          <Button onClick={() => setResultsOpen(true)}>Open results</Button>
        </div>
      ) : null}
      </div>} />
      {shareUrl ? (
        <Modal title="Copy design link" onClose={() => setShareUrl(null)}>
          <p>Your browser could not copy the link automatically. Copy it from the field below.</p>
          <input className="ui-input cart-share-link__field" type="text" readOnly aria-label="Design link"
            value={shareUrl} autoFocus onFocus={(event) => event.currentTarget.select()} />
          <div className="cart-reset__actions">
            <Button variant="ghost" onClick={() => setShareUrl(null)}>Close</Button>
          </div>
        </Modal>
      ) : null}
      {resultsOpen && evaluation ? (
        <Modal title="Global Cart results" onClose={() => setResultsOpen(false)}>
          <div className="cart-results-modal__scroll">
            <CartResultsPanel graph={graph} evaluation={evaluation} telemetry={telemetry}
              onFocusNode={(id) => { useCartStore.getState().select({ type: 'node', id }); setResultsOpen(false); }}
              onFocusEdge={(id) => { useCartStore.getState().select({ type: 'edge', id }); setResultsOpen(false); }} />
          </div>
        </Modal>
      ) : null}
    </>
  );
}
