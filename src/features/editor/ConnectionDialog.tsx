import { Link2, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  NODE_KIND_LABELS,
  type EdgeSourcePort,
  type GraphDocument,
  type NodeKind,
} from '../../domain';
import { useEditorStore } from '../../state/editor-store';
import { Button } from '../../ui/Button';
import { Modal } from '../../ui/Modal';
import { PORT_LABELS } from '../editor/canvas-model';

const PORTS_BY_KIND: Readonly<Record<NodeKind, readonly EdgeSourcePort[]>> = {
  client: ['out'],
  loadBalancer: ['out'],
  appServer: ['read', 'write'],
  cache: ['miss'],
  database: [],
};

export function ConnectionDialog({
  graph,
  locked,
  onClose,
}: {
  graph: GraphDocument;
  locked: boolean;
  onClose: () => void;
}) {
  const addEdge = useEditorStore((state) => state.addEdge);
  const removeEdge = useEditorStore((state) => state.removeEdge);
  const [source, setSource] = useState(
    graph.nodes.find((node) => PORTS_BY_KIND[node.kind].length > 0)?.id ?? '',
  );
  const sourceNode = graph.nodes.find((node) => node.id === source);
  const ports = sourceNode ? PORTS_BY_KIND[sourceNode.kind] : [];
  const [port, setPort] = useState<EdgeSourcePort>(ports[0] ?? 'out');
  const targets = graph.nodes.filter(
    (node) => node.kind !== 'client' && node.id !== source,
  );
  const [target, setTarget] = useState(targets[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const result = addEdge(source, port, target);
    if (result.ok) {
      onClose();
      return;
    }
    setError(
      result.issues?.[0]
        ? result.issues[0].message
        : (result.message ?? 'Connection rejected'),
    );
  };

  return (
    <Modal title="Connect components" onClose={onClose}>
      <form
        className="connection-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className="connection-form__intro">
          An alternative to dragging: choose a source, a port, and a target. An
          illegal connection is rejected with an explanation.
        </p>
        <div className="connection-form__grid">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="connect-source">
              Source
            </label>
            <select
              id="connect-source"
              className="ui-input"
              value={source}
              onChange={(event) => {
                const nextId = event.target.value;
                setSource(nextId);
                const nextNode = graph.nodes.find((node) => node.id === nextId);
                const nextPorts = nextNode ? PORTS_BY_KIND[nextNode.kind] : [];
                setPort(nextPorts[0] ?? 'out');
                if (nextId === target) {
                  setTarget(
                    graph.nodes.find(
                      (node) => node.kind !== 'client' && node.id !== nextId,
                    )?.id ?? '',
                  );
                }
              }}
            >
              {graph.nodes
                .filter((node) => PORTS_BY_KIND[node.kind].length > 0)
                .map((node) => (
                  <option value={node.id} key={node.id}>
                    {node.label} · {NODE_KIND_LABELS[node.kind]}
                  </option>
                ))}
            </select>
          </div>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="connect-port">
              Source port
            </label>
            <select
              id="connect-port"
              className="ui-input"
              value={port}
              onChange={(event) =>
                setPort(event.target.value as EdgeSourcePort)
              }
            >
              {ports.map((item) => (
                <option value={item} key={item}>
                  {PORT_LABELS[item]}
                </option>
              ))}
            </select>
          </div>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="connect-target">
              Target
            </label>
            <select
              id="connect-target"
              className="ui-input"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              {targets.map((node) => (
                <option value={node.id} key={node.id}>
                  {node.label} · {NODE_KIND_LABELS[node.kind]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {error ? (
          <p className="connection-form__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="connection-form__actions">
          <Button variant="primary" type="submit" icon={<Link2 size={16} />} disabled={locked}>
            Create connection
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>

      <section className="connection-list">
        <h3>Existing connections</h3>
        {graph.edges.length === 0 ? (
          <p>No connections yet.</p>
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
                    {sourceLabel} → {targetLabel} · {PORT_LABELS[edge.sourcePort]}
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
                    aria-label={`Delete connection ${sourceLabel} → ${targetLabel}`}
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
