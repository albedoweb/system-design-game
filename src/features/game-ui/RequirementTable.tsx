import type { ReactNode } from 'react';

import { DASH } from '../../ui/format';
import './game-ui.css';

export type RequirementColumnKey = 'actual' | 'limit' | 'requirement' | 'result' | 'focus';

export interface RequirementResult {
  /** `null` means the metric was not measured; it is shown as "—", never Pass. */
  passed: boolean | null;
  label?: string;
}

export interface RequirementRow {
  key: string;
  /** Requirement/gate name. Rendered as the row header verbatim. */
  label: ReactNode;
  /** Supporting detail under the name (reason, message, scope). */
  detail?: ReactNode;
  actual?: ReactNode;
  limit?: ReactNode;
  requirement?: ReactNode;
  result?: RequirementResult;
  focus?: ReactNode;
  /**
   * Optional extra row content, e.g. the Image Atlas guided explanation.
   * Rendered in its own full-width row so per-level detail is preserved.
   */
  extra?: ReactNode;
}

export interface RequirementTableProps {
  rows: RequirementRow[];
  /** Header of the first column; the third level calls these "Gate". */
  nameLabel?: string;
  columns?: RequirementColumnKey[];
  columnLabels?: Partial<Record<RequirementColumnKey, string>>;
  caption?: ReactNode;
  dense?: boolean;
  minWidthPx?: number;
  empty?: ReactNode;
  note?: ReactNode;
  className?: string;
}

const DEFAULT_COLUMNS: RequirementColumnKey[] = [
  'actual',
  'limit',
  'requirement',
  'result',
];

const DEFAULT_LABELS: Record<RequirementColumnKey, string> = {
  actual: 'Actual',
  limit: 'Limit',
  requirement: 'Requirement',
  result: 'Result',
  focus: 'Focus',
};

function renderResult(result: RequirementResult | undefined): ReactNode {
  if (!result || result.passed === null) {
    return DASH;
  }
  return (
    <span className={result.passed ? 'is-pass' : 'is-fail'}>
      {result.label ?? (result.passed ? 'Pass' : 'Fail')}
    </span>
  );
}

/**
 * Shared requirement table used by every level's checks/gates. Precision is
 * preserved because actual and limit values stay caller-formatted nodes.
 */
export function RequirementTable({
  rows,
  nameLabel = 'Requirement',
  columns = DEFAULT_COLUMNS,
  columnLabels,
  caption,
  dense = false,
  minWidthPx,
  empty = <p className="game-report-section__note">No requirements were reported.</p>,
  note,
  className,
}: RequirementTableProps) {
  if (rows.length === 0) {
    return <>{empty}</>;
  }
  const labels = { ...DEFAULT_LABELS, ...columnLabels };
  const cellFor = (row: RequirementRow, column: RequirementColumnKey): ReactNode => {
    switch (column) {
      case 'actual':
        return row.actual ?? DASH;
      case 'limit':
        return row.limit ?? DASH;
      case 'requirement':
        return row.requirement ?? DASH;
      case 'result':
        return renderResult(row.result);
      case 'focus':
        return row.focus ?? DASH;
    }
  };
  return (
    <>
      <div className={['game-table-wrap', className].filter(Boolean).join(' ')}>
        <table
          className={['game-table', dense ? 'game-table--dense' : '']
            .filter(Boolean)
            .join(' ')}
          style={minWidthPx !== undefined ? { minWidth: `${minWidthPx}px` } : undefined}
        >
          {caption ? <caption>{caption}</caption> : null}
          <thead>
            <tr>
              <th scope="col">{nameLabel}</th>
              {columns.map((column) => (
                <th scope="col" key={column}>
                  {labels[column]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <RequirementTableRow
                key={row.key}
                row={row}
                columns={columns}
                cellFor={cellFor}
              />
            ))}
          </tbody>
        </table>
      </div>
      {note ? <p className="game-report-section__note">{note}</p> : null}
    </>
  );
}

function RequirementTableRow({
  row,
  columns,
  cellFor,
}: {
  row: RequirementRow;
  columns: RequirementColumnKey[];
  cellFor: (row: RequirementRow, column: RequirementColumnKey) => ReactNode;
}) {
  return (
    <>
      <tr>
        <th scope="row">
          {row.label}
          {row.detail ? <span className="game-table__sub">{row.detail}</span> : null}
        </th>
        {columns.map((column) => (
          <td key={column}>{cellFor(row, column)}</td>
        ))}
      </tr>
      {row.extra ? (
        <tr className="game-table__extra">
          <td colSpan={columns.length + 1}>{row.extra}</td>
        </tr>
      ) : null}
    </>
  );
}
