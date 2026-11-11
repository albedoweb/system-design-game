import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  Notice,
  ReportSection,
  ReportTable,
  RequirementTable,
  SidePanel,
  TelemetryPanel,
  WorkspaceLayout,
  WorkspaceToolbar,
} from './index';

describe('Notice', () => {
  it('renders the shared notice tone and dismiss action', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Notice tone="danger" title="Run blocked" onClose={onClose}>
        <p>Fix the graph.</p>
      </Notice>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Run blocked');
    expect(screen.getByText('Fix the graph.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Dismiss notification' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('uses status semantics for non-error tones', () => {
    render(<Notice tone="warning" title="3 warnings" />);
    expect(screen.getByRole('status')).toHaveTextContent('3 warnings');
  });
});

describe('WorkspaceToolbar', () => {
  function renderToolbar(props: Partial<Parameters<typeof WorkspaceToolbar>[0]> = {}) {
    const handlers = {
      onUndo: vi.fn(),
      onRedo: vi.fn(),
      onConnect: vi.fn(),
      onExport: vi.fn(),
      onImport: vi.fn(),
      onReset: vi.fn(),
      onToggleLeft: vi.fn(),
      onToggleRight: vi.fn(),
    };
    render(
      <WorkspaceToolbar
        leftOpen={false}
        rightOpen
        canUndo
        canRedo={false}
        locked={false}
        {...handlers}
        {...props}
      />,
    );
    return handlers;
  }

  it('keeps the shared labels and disabled states', async () => {
    const user = userEvent.setup();
    const handlers = renderToolbar({ locked: true, canUndo: false });

    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(handlers.onExport).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('toolbar', { name: 'Graph actions' })).toBeVisible();
  });

  it('renders level actions and panel toggles with controlled state', async () => {
    const user = userEvent.setup();
    const onToggleLeft = vi.fn();
    const onToggleRight = vi.fn();
    const onFocusIssues = vi.fn();
    renderToolbar({ onToggleLeft, onToggleRight, rightActions: <button type="button" onClick={onFocusIssues}>Issues</button> });

    const task = screen.getByRole('button', { name: 'Task' });
    expect(task).toHaveAttribute('aria-expanded', 'false');
    await user.click(task);
    expect(onToggleLeft).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Properties' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Properties' }));
    expect(onToggleRight).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Issues' }));
    expect(onFocusIssues).toHaveBeenCalledTimes(1);
  });
});

describe('SidePanel', () => {
  it('exposes controlled task tabs and a close action', async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    const onClose = vi.fn();
    render(
      <SidePanel
        side="left"
        label="Task and components"
        open={false}
        onClose={onClose}
        tabs={[
          { id: 'task', label: 'Task' },
          { id: 'palette', label: 'Components' },
        ]}
        activeTab="task"
        onTabChange={onTabChange}
        closeLabel="Close left panel"
      >
        <p>Briefing</p>
      </SidePanel>,
    );

    const panel = screen.getByRole('complementary', { name: 'Task and components' });
    const tabs = within(panel).getByRole('tablist', { name: 'Left panel' });
    const taskTab = within(tabs).getByRole('tab', { name: 'Task' });
    const paletteTab = within(tabs).getByRole('tab', { name: 'Components' });
    expect(taskTab).toHaveAttribute('aria-selected', 'true');
    expect(taskTab).toHaveAttribute('tabindex', '0');
    expect(paletteTab).toHaveAttribute('tabindex', '-1');
    const tabPanel = within(panel).getByRole('tabpanel');
    expect(taskTab).toHaveAttribute('aria-controls', tabPanel.id);
    expect(tabPanel).toHaveAttribute('aria-labelledby', taskTab.id);
    // The close action must not be part of the tab composite.
    expect(within(tabs).queryByRole('button', { name: 'Close left panel' })).toBeNull();
    await user.click(paletteTab);
    expect(onTabChange).toHaveBeenCalledWith('palette');
    await user.click(within(panel).getByRole('button', { name: 'Close left panel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('supports arrow-key navigation between task tabs', async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(
      <SidePanel
        side="left"
        label="Task and components"
        open
        onClose={() => undefined}
        tabs={[
          { id: 'task', label: 'Task' },
          { id: 'palette', label: 'Components' },
        ]}
        activeTab="task"
        onTabChange={onTabChange}
      >
        <p>Briefing</p>
      </SidePanel>,
    );

    const taskTab = screen.getByRole('tab', { name: 'Task' });
    taskTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(onTabChange).toHaveBeenCalledWith('palette');
    await user.keyboard('{End}');
    expect(onTabChange).toHaveBeenLastCalledWith('palette');
    await user.keyboard('{Home}');
    expect(onTabChange).toHaveBeenLastCalledWith('task');
  });

  it('gives the inspector panel a close button instead of tabs', () => {
    render(
      <SidePanel side="right" label="Inspector" open onClose={() => undefined}>
        <p>Properties</p>
      </SidePanel>,
    );
    const panel = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(panel).queryByRole('tablist')).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Close inspector' })).toBeVisible();
  });
});

describe('WorkspaceLayout', () => {
  it('renders the slots and only shows a backdrop for the compact overlay', async () => {
    const user = userEvent.setup();
    const onClosePanels = vi.fn();
    const { rerender } = render(
      <WorkspaceLayout
        leftOpen
        rightOpen={false}
        compact={false}
        onClosePanels={onClosePanels}
        leftPanel={<SidePanel side="left" label="Left" open onClose={() => undefined}>left</SidePanel>}
        rightPanel={<SidePanel side="right" label="Right" open onClose={() => undefined}>right</SidePanel>}
        toolbar={<div>toolbar</div>}
        canvas={<div>canvas</div>}
        telemetry={<div>telemetry</div>}
      />,
    );

    expect(screen.getByText('toolbar')).toBeVisible();
    expect(screen.getByText('canvas')).toBeVisible();
    expect(screen.getByText('telemetry')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Close panels' })).not.toBeInTheDocument();

    rerender(
      <WorkspaceLayout
        leftOpen
        rightOpen={false}
        compact
        onClosePanels={onClosePanels}
        leftPanel={<SidePanel side="left" label="Left" open onClose={() => undefined}>left</SidePanel>}
        rightPanel={<SidePanel side="right" label="Right" open onClose={() => undefined}>right</SidePanel>}
        toolbar={<div>toolbar</div>}
        canvas={<div>canvas</div>}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Close panels' }));
    expect(onClosePanels).toHaveBeenCalledTimes(1);
  });

  it('keeps an open drawer above the compact backdrop', async () => {
    const user = userEvent.setup();
    const onPanelAction = vi.fn();
    render(
      <WorkspaceLayout
        leftOpen
        rightOpen={false}
        compact
        onClosePanels={() => undefined}
        leftPanel={
          <SidePanel
            side="left"
            label="Left"
            open
            onClose={() => undefined}
            tabs={[{ id: 'task', label: 'Task' }]}
            activeTab="task"
          >
            <button type="button" onClick={onPanelAction}>
              Panel action
            </button>
          </SidePanel>
        }
        rightPanel={<SidePanel side="right" label="Right" open onClose={() => undefined}>right</SidePanel>}
        toolbar={<div>toolbar</div>}
        canvas={<div>canvas</div>}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Panel action' }));
    expect(onPanelAction).toHaveBeenCalledTimes(1);

    const css = readFileSync(
      resolve(process.cwd(), 'src/features/game-ui/game-ui.css'),
      'utf8',
    );
    const backdropZ = Number(
      /\.game-workspace__backdrop\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1],
    );
    const panelZ = Number(
      /\.game-side-panel\.is-open\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1],
    );
    expect(backdropZ).toBeGreaterThan(0);
    expect(panelZ).toBeGreaterThan(backdropZ);
  });
});

describe('TelemetryPanel', () => {
  it('controls the panel through the shared toggle and applies a resized height', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    function Harness() {
      const panelRef = useRef<HTMLElement>(null);
      return (
        <TelemetryPanel
          title="Results & telemetry"
          summary="Not passed"
          open
          onOpenChange={onOpenChange}
          height={320}
          panelRef={panelRef}
          bodyId="demo-body"
          ariaLabel="Results and telemetry"
          className="level-results"
        >
          <p>Measurement</p>
        </TelemetryPanel>
      );
    }
    render(<Harness />);

    const panel = screen.getByLabelText('Results and telemetry');
    expect(panel).toHaveClass('game-telemetry', 'level-results');
    expect(panel).toHaveStyle({ height: '320px' });
    const toggle = screen.getByRole('button', { name: /Results & telemetry/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'demo-body');
    expect(screen.getByText('Not passed')).toBeVisible();
    await user.click(toggle);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('hides the body when closed', () => {
    render(
      <TelemetryPanel
        title="Telemetry"
        open={false}
        onOpenChange={() => undefined}
        bodyId="closed-body"
        ariaLabel="Telemetry"
      >
        <p>hidden</p>
      </TelemetryPanel>,
    );
    expect(screen.queryByText('hidden')).not.toBeInTheDocument();
  });
});

describe('ReportSection', () => {
  it('renders a semantic heading with description and note', () => {
    render(
      <ReportSection title="Operations" description="Measured requests" note="Successful only">
        <p>table</p>
      </ReportSection>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Operations' })).toBeVisible();
    expect(screen.getByText('Measured requests')).toBeVisible();
    expect(screen.getByText('Successful only')).toBeVisible();
  });
});

describe('ReportTable', () => {
  it('keeps caption, column headers and row headers semantic', () => {
    render(
      <ReportTable
        rowHeaderLabel="Operation"
        caption="Measured operations"
        minWidthPx={900}
        columns={[
          { key: 'offered', label: 'Offered' },
          { key: 'p95', label: 'p95', title: 'Successful requests only' },
        ]}
        rows={[
          { key: 'read', header: 'Read', cells: [1234, '12.5 ms'] },        ]}
        note="Availability includes failures."
      />,
    );

    expect(screen.getByText('Measured operations')).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Operation' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'p95' })).toHaveAttribute(
      'title',
      'Successful requests only',
    );
    expect(screen.getByRole('rowheader', { name: 'Read' })).toBeVisible();
    expect(screen.getByRole('cell', { name: '1234' })).toBeVisible();
    expect(screen.getByRole('cell', { name: '12.5 ms' })).toBeVisible();
    expect(screen.getByText('Availability includes failures.')).toBeVisible();
  });

  it('omits the table when no rows were reported', () => {
    render(
      <ReportTable
        rowHeaderLabel="Operation"
        columns={[{ key: 'offered', label: 'Offered' }]}
        rows={[]}
      />,
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('No rows were reported.')).toBeVisible();
  });
});

describe('RequirementTable', () => {
  it('never turns a missing measurement into a pass', () => {
    render(
      <RequirementTable
        nameLabel="Check"
        columnLabels={{ limit: 'Target' }}
        rows={[
          {
            key: 'availability',
            label: 'Read availability',
            actual: '99.80%',
            limit: '99.50%',
            result: { passed: true },
          },
          {
            key: 'p95',
            label: 'Read p95',
            actual: '—',
            limit: '250 ms',
            result: { passed: null },
          },
        ]}
      />,
    );

    expect(screen.getByRole('columnheader', { name: 'Target' })).toBeVisible();
    expect(screen.getByText('99.80%')).toBeVisible();
    const unknownRow = screen.getByRole('rowheader', { name: 'Read p95' }).closest('tr')!;
    expect(within(unknownRow).getAllByRole('cell', { name: '—' }).length).toBeGreaterThan(0);
    expect(within(unknownRow).queryByText('Pass')).not.toBeInTheDocument();
  });

  it('renders per-row focus actions and extra detail rows without losing precision', async () => {
    const user = userEvent.setup();
    const onFocus = vi.fn();
    render(
      <RequirementTable
        nameLabel="Gate"
        columns={['actual', 'limit', 'result', 'focus']}
        rows={[
          {
            key: 'gate',
            label: 'Detail p99.9',
            detail: '0.003% of successful samples',
            actual: '0.0031 %',
            limit: '≤ 0.001 %',
            result: { passed: false },
            focus: (
              <button type="button" onClick={onFocus}>
                Focus node
              </button>
            ),
            extra: <p>Guided explanation</p>,
          },
        ]}
      />,
    );

    expect(screen.getByText('0.0031 %')).toBeVisible();
    expect(screen.getByText('≤ 0.001 %')).toBeVisible();
    expect(screen.getAllByText('Fail').length).toBe(1);
    expect(screen.getByText('Guided explanation')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Focus node' }));
    expect(onFocus).toHaveBeenCalledTimes(1);
  });
});
