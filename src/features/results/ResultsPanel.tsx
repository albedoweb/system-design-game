import { AlertTriangle, CheckCircle2, CircleHelp, XCircle } from 'lucide-react';

import {
  type Diagnostic,
  type GraphDocument,
  type LevelDefinition,
  type RunResult,
  type SloCheck,
} from '../../domain';
import { ReportSection, RequirementTable } from '../game-ui';
import { bestLocalLabel, type BestLocalResult } from '../../state/local-best';
import {
  formatDecimal,
  formatInteger,
  formatMoney,
  formatMicroUsd,
} from '../../ui/format';
import { StatusPill } from '../../ui/StatusPill';
import './results.css';

function checkActual(check: SloCheck): string {
  if (check.actual === null) {
    return '—';
  }
  if (check.unit === '%') {
    return `${formatDecimal(check.actual, 2)}%`;
  }
  if (check.unit === '$/h') {
    return formatMoney(check.actual);
  }
  return `${formatDecimal(check.actual, 1)} ms`;
}

function checkTarget(check: SloCheck): string {
  if (check.unit === '%') {
    return `${formatDecimal(check.target, 2)}%`;
  }
  if (check.unit === '$/h') {
    return formatMoney(check.target);
  }
  return `${formatDecimal(check.target, 0)} ms`;
}

function DiagnosticRow({
  diagnostic,
  graph,
  onSelectNode,
}: {
  diagnostic: Diagnostic;
  graph: GraphDocument;
  onSelectNode: (id: string) => void;
}) {
  const icon =
    diagnostic.severity === 'error' ? (
      <XCircle size={16} aria-hidden="true" />
    ) : diagnostic.severity === 'warning' ? (
      <AlertTriangle size={16} aria-hidden="true" />
    ) : (
      <CircleHelp size={16} aria-hidden="true" />
    );
  const node = diagnostic.nodeId
    ? graph.nodes.find((item) => item.id === diagnostic.nodeId)
    : undefined;
  return (
    <li className={`diagnostic diagnostic--${diagnostic.severity}`}>
      <span className="diagnostic__icon">{icon}</span>
      <div>
        <p>{diagnostic.message}</p>
        {node ? (
          <button type="button" onClick={() => onSelectNode(node.id)}>
            Show “{node.label}”
          </button>
        ) : null}
      </div>
    </li>
  );
}

export function ResultsPanel({
  result,
  graph,
  level,
  revision,
  resultRevision,
  currentSeed,
  best,
  bestError,
  isNewBest,
  onSelectNode,
}: {
  result: RunResult;
  graph: GraphDocument;
  level: LevelDefinition;
  revision: number;
  resultRevision: number | null;
  currentSeed: number;
  best: BestLocalResult | null;
  bestError: string | null;
  isNewBest: boolean;
  onSelectNode: (id: string) => void;
}) {
  const stale = result.seed !== currentSeed ||
    (resultRevision !== null && resultRevision !== revision);
  return (
    <div className="results">
      <div
        className={`results__banner ${result.passed ? 'is-pass' : 'is-fail'}`}
        role="status"
      >
        {result.passed ? (
          <CheckCircle2 size={22} aria-hidden="true" />
        ) : (
          <XCircle size={22} aria-hidden="true" />
        )}
        <div>
          <p className="results__eyebrow">Run result</p>
          <h2>{result.passed ? 'Passed' : 'Not passed'}</h2>
          <p>
            Starting cost: {formatMicroUsd(result.costMicroUsdPerHour)}/h · seed{' '}
            {formatInteger(result.seed)}
          </p>
        </div>
      </div>

      {stale ? (
        <p className="results__stale" role="status">
          This is the result of a previous run: the graph or settings have
          changed. Run the simulation again for a fresh evaluation.
        </p>
      ) : null}

      <ReportSection
        title="SLO checks"
        note="Checks without data do not pass. Pending is not success; errors and timeouts are included in the availability denominator."
      >
        <RequirementTable
          nameLabel="Check"
          columnLabels={{ limit: 'Target' }}
          columns={['actual', 'limit', 'result']}
          rows={result.checks.map((check) => ({
            key: check.id,
            label: check.label,
            actual: checkActual(check),
            limit: checkTarget(check),
            result: { passed: check.passed },
          }))}
        />
      </ReportSection>

      <ReportSection title="Diagnostics">
        {result.diagnostics.length === 0 ? (
          <p className="results__note">No specific diagnostics were reported.</p>
        ) : (
          <ul className="diagnostics">
            {result.diagnostics.map((diagnostic, index) => (
              <DiagnosticRow
                key={`${diagnostic.message}-${index}`}
                diagnostic={diagnostic}
                graph={graph}
                onSelectNode={onSelectNode}
              />
            ))}
          </ul>
        )}
      </ReportSection>

      <ReportSection title="Local best result" className="results__best">
        {best ? (
          <>
            <p>
              {formatMicroUsd(best.costMicroUsdPerHour)}/h · read p95{' '}
              {best.readP95Ms === null
                ? '—'
                : `${formatDecimal(best.readP95Ms, 1)} ms`}
            </p>
            <p className="results__note">{bestLocalLabel(level, result.seed)}</p>
            {isNewBest ? (
              <StatusPill tone="success">New local best result</StatusPill>
            ) : null}
          </>
        ) : (
          <p className="results__note">
            No passing result for this seed and version set yet. Failing runs
            are not ranked.
          </p>
        )}
        {bestError ? (
          <p className="results__warning" role="alert">
            {bestError}
          </p>
        ) : null}
        <p className="results__note">
          Comparison is local to this device and only for the same
          content/model/pricing versions and seed. This is not a global
          leaderboard.
        </p>
      </ReportSection>
    </div>
  );
}
