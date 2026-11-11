import { Link2, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { ScoreboardGraph } from '../index';
import { Button } from '../../ui/Button';
import { Modal } from '../../ui/Modal';
import {
  SCOREBOARD_NODE_KIND_LABELS,
  scoreboardLinkLabel,
  scoreboardLinkLongLabel,
  scoreboardRoleOfKinds,
} from './scoreboard-meta';
import { useScoreboardStore } from './scoreboard-store';

export interface ScoreboardConnectRequest {
  source: string;
  target: string;
}

function invalidPairMessage(
  graph: ScoreboardGraph,
  source: string,
  target: string,
): string | null {
  if (source === target) {
    return 'A component cannot connect to itself.';
  }
  const sourceNode = graph.nodes.find((node) => node.id === source);
  const targetNode = graph.nodes.find((node) => node.id === target);
  if (!sourceNode || !targetNode) {
    return 'Choose existing components.';
  }
  if (scoreboardRoleOfKinds(sourceNode.kind, targetNode.kind) === null) {
    return `A ${sourceNode.kind} component cannot connect directly to a ${targetNode.kind} component in this level.`;
  }
  if (
    graph.edges.some((edge) => edge.from === source && edge.to === target)
  ) {
    return 'These components are already connected. Remove the existing connection first.';
  }
  return null;
}

export function ScoreboardConnectDialog({
  graph,
  locked,
  initial,
  onClose,
}: {
  graph: ScoreboardGraph;
  locked: boolean;
  initial?: ScoreboardConnectRequest;
  onClose: () => void;
}) {
  const addEdge = useScoreboardStore((state) => state.addEdge);
  const removeEdge = useScoreboardStore((state) => state.removeEdge);
  const [source, setSource] = useState(
    initial?.source ?? graph.nodes.find((node) => node.kind === 'users')?.id ?? '',
  );
  const [target, setTarget] = useState(
    initial?.target ??
      graph.nodes.find(
        (node) => node.id !== (initial?.source ?? graph.nodes[0]?.id),
      )?.id ??
      '',
  );
  const [error, setError] = useState<string | null>(null);

  const sourceNode = graph.nodes.find((node) => node.id === source);
  const targetNode = graph.nodes.find((node) => node.id === target);
  const role = useMemo(
    () =>
      sourceNode && targetNode
        ? scoreboardRoleOfKinds(sourceNode.kind, targetNode.kind)
        : null,
    [sourceNode, targetNode],
  );
  const invalid = invalidPairMessage(graph, source, target);

  const submit = () => {
    if (invalid) {
      setError(invalid);
      return;
    }
    const result = addEdge(source, target);
    if (result.ok) {
      onClose();
      return;
    }
    setError(result.message ?? 'Connection rejected.');
  };

  return (
    <Modal title="Connect components" onClose={onClose}>
      <form
        className="scoreboard-connection-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className="scoreboard-connection-form__intro">
          Pick a source and a target. The dependency role comes from the
          component pair, so no hidden port decides the route. Application →
          SQL Database is the primary path for vote writes and any direct reads.
        </p>
        <div className="scoreboard-connection-form__grid">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="scoreboard-connect-source">
              Source
            </label>
            <select
              id="scoreboard-connect-source"
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
                setError(null);
              }}
            >
              {graph.nodes.map((node) => (
                <option value={node.id} key={node.id}>
                  {node.label} · {SCOREBOARD_NODE_KIND_LABELS[node.kind]}
                </option>
              ))}
            </select>
          </div>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="scoreboard-connect-target">
              Target
            </label>
            <select
              id="scoreboard-connect-target"
              className="ui-input"
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                setError(null);
              }}
            >
              {graph.nodes.map((node) => (
                <option value={node.id} key={node.id}>
                  {node.label} · {SCOREBOARD_NODE_KIND_LABELS[node.kind]}
                </option>
              ))}
            </select>
          </div>
          <div className="ui-field scoreboard-connection-form__role">
            <span className="ui-field__label">Inferred role</span>
            <p className="scoreboard-connection-form__role-value">
              {role ? (
                <>
                  <strong>{scoreboardLinkLabel(role)}</strong>
                  <span>{scoreboardLinkLongLabel(role)}</span>
                </>
              ) : (
                'No valid route for this pair'
              )}
            </p>
          </div>
        </div>

        {invalid ? (
          <p className="scoreboard-connection-form__error" role="alert">
            {invalid}
          </p>
        ) : null}
        {error ? (
          <p className="scoreboard-connection-form__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="scoreboard-connection-form__actions">
          <Button
            variant="primary"
            type="submit"
            icon={<Link2 size={16} />}
            disabled={locked || invalid !== null}
          >
            Create connection
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>

      <section className="scoreboard-connection-list">
        <h3>Existing connections</h3>
        {graph.edges.length === 0 ? (
          <p>No connections yet.</p>
        ) : (
          <ul>
            {graph.edges.map((edge) => {
              const from = graph.nodes.find((node) => node.id === edge.from);
              const to = graph.nodes.find((node) => node.id === edge.to);
              const edgeRole =
                from && to ? scoreboardRoleOfKinds(from.kind, to.kind) : null;
              return (
                <li key={edge.id}>
                  <span>
                    {from?.label ?? edge.from} → {to?.label ?? edge.to} ·{' '}
                    {scoreboardLinkLabel(edgeRole)}
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
                    aria-label={`Delete ${scoreboardLinkLabel(
                      edgeRole,
                    )} connection ${from?.label ?? edge.from} to ${
                      to?.label ?? edge.to
                    }`}
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
