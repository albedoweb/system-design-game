import { Link2, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { ImageGraph, ImageOperation, ImageRegion } from '../contracts';
import { Button } from '../../ui/Button';
import { Modal } from '../../ui/Modal';
import {
  imageConnectionCandidates,
  imageConnectionExplanation,
  imagePairEdges,
} from './image-canvas-model';
import {
  IMAGE_NODE_KIND_LABELS,
  IMAGE_OPERATION_META,
  IMAGE_REGION_LABELS,
  IMAGE_REGION_ORDER,
} from './image-meta';
import { useImageStore } from './image-store';

function groupByRegion(graph: ImageGraph): Array<{
  region: ImageRegion;
  nodes: ImageGraph['nodes'];
}> {
  return IMAGE_REGION_ORDER.map((region) => ({
    region,
    nodes: graph.nodes.filter((node) => node.region === region),
  }));
}

/**
 * The form opens on a pair that can actually be connected, so the inferred
 * operation is visible instead of an empty "no valid operation" state.
 */
function defaultPair(
  graph: ImageGraph,
  initial?: { source: string; target: string },
): { source: string; target: string } {
  if (initial) {
    return initial;
  }
  for (const source of graph.nodes) {
    for (const target of graph.nodes) {
      if (source.id === target.id) {
        continue;
      }
      const candidates = imageConnectionCandidates(
        source,
        target,
        imagePairEdges(graph, source.id, target.id),
      );
      if (candidates.length > 0) {
        return { source: source.id, target: target.id };
      }
    }
  }
  return {
    source: graph.nodes[0]?.id ?? '',
    target: graph.nodes[1]?.id ?? '',
  };
}

export function ImageConnectDialog({
  graph,
  locked,
  initial,
  onClose,
}: {
  graph: ImageGraph;
  locked: boolean;
  initial?: { source: string; target: string };
  onClose: () => void;
}) {
  const addEdge = useImageStore((state) => state.addEdge);
  const removeEdge = useImageStore((state) => state.removeEdge);
  const [pair] = useState(() => defaultPair(graph, initial));
  const [source, setSource] = useState(pair.source);
  const [target, setTarget] = useState(pair.target);
  const [operation, setOperation] = useState<ImageOperation | ''>('');
  const [error, setError] = useState<string | null>(null);

  const sourceNode = graph.nodes.find((node) => node.id === source);
  const targetNode = graph.nodes.find((node) => node.id === target);
  const candidates = useMemo(() => {
    if (!sourceNode || !targetNode) {
      return [];
    }
    return imageConnectionCandidates(
      sourceNode,
      targetNode,
      imagePairEdges(graph, sourceNode.id, targetNode.id),
    );
  }, [graph, sourceNode, targetNode]);
  const selectedOperation: ImageOperation | '' =
    operation !== '' && candidates.includes(operation)
      ? operation
      : (candidates[0] ?? '');

  // Nothing can point at a fixed client: hide it from the target list so the
  // form cannot offer an impossible route.
  const targetOptions = groupByRegion(graph).map((group) => ({
    ...group,
    nodes: group.nodes.filter((node) => node.kind !== 'client'),
  }));

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
        className="image-connection-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className="image-connection-form__intro">
          Pick a source and a target. The compatible operation is inferred from the two
          kinds; when a pair allows more than one, choose it explicitly here. Client
          populations and provider endpoints keep their fixed roles.
        </p>
        <div className="image-connection-form__grid">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="image-connect-source">
              Source
            </label>
            <select
              id="image-connect-source"
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
              {groupByRegion(graph).map((group) => (
                <optgroup
                  key={group.region}
                  label={IMAGE_REGION_LABELS[group.region]}
                >
                  {group.nodes.map((node) => (
                    <option value={node.id} key={node.id}>
                      {node.label} · {IMAGE_NODE_KIND_LABELS[node.kind]}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="image-connect-target">
              Target
            </label>
            <select
              id="image-connect-target"
              className="ui-input"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              {targetOptions.map((group) =>
                group.nodes.length === 0 ? null : (
                  <optgroup
                    key={group.region}
                    label={IMAGE_REGION_LABELS[group.region]}
                  >
                    {group.nodes.map((node) => (
                      <option value={node.id} key={node.id}>
                        {node.label} · {IMAGE_NODE_KIND_LABELS[node.kind]}
                      </option>
                    ))}
                  </optgroup>
                ),
              )}
            </select>
          </div>
          <div className="ui-field image-connection-form__operation">
            <label className="ui-field__label" htmlFor="image-connect-operation">
              Operation on this route
            </label>
            <select
              id="image-connect-operation"
              className="ui-input"
              value={selectedOperation}
              disabled={candidates.length === 0}
              onChange={(event) =>
                setOperation(event.target.value as ImageOperation)
              }
            >
              {candidates.length === 0 ? (
                <option value="">No valid operation</option>
              ) : null}
              {candidates.map((item) => (
                <option value={item} key={item}>
                  {IMAGE_OPERATION_META[item].label}
                </option>
              ))}
            </select>
            {selectedOperation !== '' ? (
              <p className="ui-field__hint">
                {IMAGE_OPERATION_META[selectedOperation].description}
              </p>
            ) : null}
          </div>
        </div>
        {sourceNode && targetNode && sourceNode.id !== targetNode.id &&
        candidates.length === 0 ? (
          <p className="image-connection-form__error" role="alert">
            {imageConnectionExplanation(sourceNode.kind, targetNode.kind)}
          </p>
        ) : null}
        {sourceNode && targetNode && sourceNode.id === targetNode.id ? (
          <p className="image-connection-form__error" role="alert">
            A node cannot connect to itself.
          </p>
        ) : null}
        {error ? (
          <p className="image-connection-form__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="image-connection-form__actions">
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

      <section className="image-connection-list">
        <h3>Existing routes</h3>
        <p className="image-connection-list__note">
          These are logical routes. Several routes on one region pair still share that
          pair’s single 100 Gbit/s full-duplex channel.
        </p>
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
                    {IMAGE_OPERATION_META[edge.operation].label}
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
                    aria-label={`Delete ${IMAGE_OPERATION_META[edge.operation].label} route ${sourceLabel} to ${targetLabel}`}
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
