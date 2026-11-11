import type { ReactNode } from 'react';

import { DASH } from '../../ui/format';
import './game-ui.css';

export interface ReportTableColumn {
  key: string;
  label: ReactNode;
  /** Tooltip for headers whose meaning needs a definition. */
  title?: string;
}

export interface ReportTableRow {
  key: string;
  /** Rendered as the row header (`th scope="row"`). */
  header: ReactNode;
  /** Data cells in column order; one ReactNode per column. */
  cells: ReactNode[];
}

export interface ReportTableProps {
  /** Header text for the row-header column, e.g. "Operation". */
  rowHeaderLabel: ReactNode;
  columns: ReportTableColumn[];
  rows: ReportTableRow[];
  caption?: ReactNode;
  /** Wider tables scroll inside their own frame instead of stretching the panel. */
  minWidthPx?: number;
  dense?: boolean;
  empty?: ReactNode;
  note?: ReactNode;
  ariaLabel?: string;
  className?: string;
}

/**
 * Shared report table primitive: caption, semantic column headers, row headers
 * and horizontal scrolling. Levels keep their own column sets and cell values;
 * each cell is a ReactNode so precise values are never flattened to strings.
 */
export function ReportTable({
  rowHeaderLabel,
  columns,
  rows,
  caption,
  minWidthPx,
  dense = false,
  empty = <p className="game-report-section__note">No rows were reported.</p>,
  note,
  ariaLabel,
  className,
}: ReportTableProps) {
  if (rows.length === 0) {
    return <>{empty}</>;
  }
  return (
    <>
      <div className={['game-table-wrap', className].filter(Boolean).join(' ')}>
        <table
          className={['game-table', dense ? 'game-table--dense' : '']
            .filter(Boolean)
            .join(' ')}
          style={minWidthPx !== undefined ? { minWidth: `${minWidthPx}px` } : undefined}
          aria-label={ariaLabel}
        >
          {caption ? <caption>{caption}</caption> : null}
          <thead>
            <tr>
              <th scope="col">{rowHeaderLabel}</th>
              {columns.map((column) => (
                <th scope="col" key={column.key} title={column.title}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.header}</th>
                {columns.map((column, index) => (
                  <td key={column.key}>{row.cells[index] ?? DASH}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note ? <p className="game-report-section__note">{note}</p> : null}
    </>
  );
}
