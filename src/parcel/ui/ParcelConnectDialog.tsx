import { Link2, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { ParcelGraph, ParcelOperation } from '../contracts';
import { Button } from '../../ui/Button';
import { Modal } from '../../ui/Modal';
import {
  parcelConnectionCandidates,
  parcelConnectionExplanation,
  parcelPairEdges,
} from './parcel-canvas-model';
import { PARCEL_NODE_KIND_LABELS, PARCEL_OPERATION_META } from './parcel-meta';
import { useParcelStore } from './parcel-store';

export function ParcelConnectDialog({
  graph,
  locked,
  initial,
  onClose,
}: {
  graph: ParcelGraph;
  locked: boolean;
  initial?: { source: string; target: string };
  onClose: () => void;
}) {
  const addEdge = useParcelStore((state) => state.addEdge);
  const removeEdge = useParcelStore((state) => state.removeEdge);
  const app = graph.nodes.find((node) => node.kind === 'app');
  const firstStore = graph.nodes.find((node) => node.kind !== 'client');
  const [source, setSource] = useState(
    initial?.source ?? app?.id ?? graph.nodes[0]?.id ?? '',
  );
  const [target, setTarget] = useState(
    initial?.target ??
      graph.nodes.find((node) => node.id !== (initial?.source ?? app?.id))?.id ??
      firstStore?.id ??
      '',
  );
  const [operation, setOperation] = useState<ParcelOperation | ''>('');
  const [error, setError] = useState<string | null>(null);

  const sourceNode = graph.nodes.find((node) => node.id === source);
  const targetNode = graph.nodes.find((node) => node.id === target);
  const candidates = useMemo(() => {
    if (!sourceNode || !targetNode) {
      return [];
    }
    return parcelConnectionCandidates(
      sourceNode,
      targetNode,
      parcelPairEdges(graph, sourceNode.id, targetNode.id),
    );
  }, [graph, sourceNode, targetNode]);
  const selectedOperation: ParcelOperation | '' =
    operation !== '' && candidates.includes(operation)
      ? operation
      : (candidates[0] ?? '');

  const targetOptions = graph.nodes.filter((node) => node.kind !== 'client');

  const submit = () => {
    if (!source || !target || selectedOperation === '') {
      setError('Choose a source, target and operation.');
      return;
    }
    const result = addEdge(source, target, selectedOperation);
    if (result.ok) {
      onClose();
      return;
    }
    setError(result.message ?? 'Route rejected.');
  };

  return (
    <Modal title="Connect nodes" onClose={onClose}>
      <form
        className="parcel-connection-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className="parcel-connection-form__intro">
          Pick a source and a target. The operation is chosen here, so no connector
          hides a cache, database or read role. If only one operation is still
          missing for the pair, the canvas selects it automatically.
        </p>
        <div className="parcel-connection-form__grid">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="parcel-connect-source">
              Source
            </label>
            <select
              id="parcel-connect-source"
              className="ui-input"
              value={source}
              onChange={(event) => {
                const next = event.target.value;
                setSource(next);
                if (next === target) {
                  setTarget(
                    graph.nodes.find((node) => node.id !== next)?.id ?? '',
                  );
                }
              }}
            >
              {graph.nodes.map((node) => (
                <option value={node.id} key={node.id}>
                  {node.label} · {PARCEL_NODE_KIND_LABELS[node.kind]}
                </option>
              ))}
            </select>
          </div>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="parcel-connect-target">
              Target
            </label>
            <select
              id="parcel-connect-target"
              className="ui-input"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              {targetOptions.map((node) => (
                <option value={node.id} key={node.id}>
                  {node.label} · {PARCEL_NODE_KIND_LABELS[node.kind]}
                </option>
              ))}
            </select>
          </div>
          <div className="ui-field parcel-connection-form__operation">
            <label className="ui-field__label" htmlFor="parcel-connect-operation">
              Operation on this route
            </label>
            <select
              id="parcel-connect-operation"
              className="ui-input"
              value={selectedOperation}
              disabled={candidates.length === 0}
              onChange={(event) =>
                setOperation(event.target.value as ParcelOperation)
              }
            >
              {candidates.length === 0 ? (
                <option value="">No valid operation</option>
              ) : null}
              {candidates.map((item) => (
                <option value={item} key={item}>
                  {PARCEL_OPERATION_META[item].label}
                </option>
              ))}
            </select>
            {selectedOperation !== '' ? (
              <p className="ui-field__hint">
                {PARCEL_OPERATION_META[selectedOperation].description}
              </p>
            ) : null}
          </div>
        </div>
        {sourceNode && targetNode && candidates.length === 0 ? (
          <p className="parcel-connection-form__error" role="alert">
            {sourceNode.id === targetNode.id
              ? 'A node cannot connect to itself.'
              : parcelConnectionExplanation(sourceNode.kind, targetNode.kind)}
          </p>
        ) : null}
        {error ? (
          <p className="parcel-connection-form__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="parcel-connection-form__actions">
          <Button
            variant="primary"
            type="submit"
            icon={<Link2 size={16} />}
            disabled={locked || candidates.length === 0}
          >
            Create route
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>

      <section className="parcel-connection-list">
        <h3>Existing routes</h3>
        {graph.edges.length === 0 ? (
          <p>No routes yet.</p>
        ) : (
          <ul>
            {graph.edges.map((edge) => {
              const sourceLabel =
                graph.nodes.find((node) => node.id === edge.source)?.label ??
                edge.source;
              const targetLabel =
                graph.nodes.find((node) => node.id === edge.target)?.label ??
                edge.target;
              return (
                <li key={edge.id}>
                  <span>
                    {sourceLabel} → {targetLabel} ·{' '}
                    {PARCEL_OPERATION_META[edge.operation].label}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={14} />}
                    disabled={locked}
                    onClick={() => {
                      const result = removeEdge(edge.id);
                      if (!result.ok) {
                        setError(result.message ?? null);
                      }
                    }}
                    aria-label={`Delete ${PARCEL_OPERATION_META[edge.operation].label} route ${sourceLabel} to ${targetLabel}`}
                  >
                    Delete
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Modal>
  );
}
