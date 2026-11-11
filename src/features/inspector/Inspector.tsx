import { calculateCostUsd, type LevelDefinition } from '../../domain';
import { useEditorStore } from '../../state/editor-store';
import { isSessionLocked, useSessionStore } from '../../state/session-store';
import { useRunEvidence } from '../simulation/run-evidence';
import { ResultsPanel } from '../results/ResultsPanel';
import {
  EdgeInspector,
  EmptyInspector,
  NodeInspector,
} from './NodeInspector';
import { snapshotNodeMetric } from './node-metrics';
import './inspector.css';

export function Inspector({ level, tab, setTab }: {
  level: LevelDefinition;
  tab: 'properties' | 'results';
  setTab: (tab: 'properties' | 'results') => void;
}) {
  const graph = useEditorStore((state) => state.graph);
  const selection = useEditorStore((state) => state.selection);
  const select = useEditorStore((state) => state.select);
  const clearSelection = useEditorStore((state) => state.clearSelection);
  const revision = useEditorStore((state) => state.configRevision);
  const evidence = useRunEvidence();
  const result = evidence.result;
  const resultRevision = useSessionStore((state) => state.resultRevision);
  const seed = useSessionStore((state) => state.seed);
  const best = useSessionStore((state) => state.best);
  const bestError = useSessionStore((state) => state.bestError);
  const isNewBest = useSessionStore((state) => state.isNewBest);
  const locked = useSessionStore((state) => isSessionLocked(state.phase));

  const selectedNode =
    selection?.type === 'node'
      ? graph.nodes.find((node) => node.id === selection.id) ?? null
      : null;
  const selectedEdge =
    selection?.type === 'edge'
      ? graph.edges.find((edge) => edge.id === selection.id) ?? null
      : null;
  const showingResults = !selection && tab === 'results' && result !== null;

  return (
    <div className="inspector-shell">
      <div className="inspector-tabs" role="tablist" aria-label="Inspector">
        <button
          type="button"
          role="tab"
          aria-selected={!showingResults}
          className={!showingResults ? 'is-active' : ''}
          onClick={() => setTab('properties')}
        >
          Properties
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={showingResults}
          className={showingResults ? 'is-active' : ''}
          disabled={result === null}
          onClick={() => {
            clearSelection();
            setTab('results');
          }}
        >
          Results
        </button>
      </div>

      <div className="inspector-scroll">
        {showingResults && result ? (
          <ResultsPanel
            result={result}
            graph={graph}
            level={level}
            revision={revision}
            resultRevision={resultRevision}
            currentSeed={seed}
            best={best}
            bestError={bestError}
            isNewBest={isNewBest}
            onSelectNode={(id) => {
              select({ type: 'node', id });
              setTab('properties');
            }}
          />
        ) : selectedNode ? (
          <NodeInspector
            node={selectedNode}
            metrics={snapshotNodeMetric(evidence.snapshot, selectedNode.id)}
            mode={evidence.mode}
            stale={evidence.stale}
            snapshotTimeMs={evidence.snapshot?.timeMs ?? null}
            diagnostics={evidence.diagnosticsByNode.get(selectedNode.id) ?? []}
            locked={locked}
            totalCostUsd={calculateCostUsd(graph)}
          />
        ) : selectedEdge ? (
          <EdgeInspector edge={selectedEdge} graph={graph} locked={locked} />
        ) : (
          <EmptyInspector hasResult={result !== null} />
        )}
      </div>
    </div>
  );
}
