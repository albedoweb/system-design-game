import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { NumberField } from './NumberField';

describe('NumberField', () => {
  it('не коммитит пустое значение и возвращает прежнее', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <NumberField
        label="Очередь"
        value={128}
        min={0}
        max={512}
        onCommit={onCommit}
      />,
    );
    const input = screen.getByRole('spinbutton', { name: 'Очередь' });
    await user.clear(input);
    await user.tab();
    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveValue(128);
  });

  it('ограничивает значение верхней границей', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <NumberField
        label="Пул"
        value={8}
        min={1}
        max={64}
        onCommit={onCommit}
      />,
    );
    const input = screen.getByRole('spinbutton', { name: 'Пул' });
    await user.clear(input);
    await user.type(input, '900{Enter}');
    expect(onCommit).toHaveBeenCalledWith(64);
  });

  it('отменяет правку по Escape', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <NumberField
        label="Пул"
        value={8}
        min={1}
        max={64}
        onCommit={onCommit}
      />,
    );
    const input = screen.getByRole('spinbutton', { name: 'Пул' });
    await user.clear(input);
    await user.type(input, '12{Escape}');
    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveValue(8);
  });
});
