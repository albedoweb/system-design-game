import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary';

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('Тестовый сбой отрисовки');
  }

  return <p>Содержимое восстановлено</p>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('показывает запасной экран, сохраняет данные и восстанавливается', async () => {
    const user = userEvent.setup();
    localStorage.setItem('draft:level-1', '{"nodes":[]}');

    const { rerender } = render(
      <ErrorBoundary>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );

    expect(
      screen.getByRole('heading', { name: 'Something went wrong' }),
    ).toBeVisible();
    expect(
      screen.getByText(/data in the browser was not changed/i),
    ).toBeVisible();
    expect(localStorage.getItem('draft:level-1')).toBe('{"nodes":[]}');

    rerender(
      <ErrorBoundary>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );

    await user.click(
      screen.getByRole('button', { name: 'Try again' }),
    );

    expect(screen.getByText('Содержимое восстановлено')).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Something went wrong' }),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem('draft:level-1')).toBe('{"nodes":[]}');
  });
});
