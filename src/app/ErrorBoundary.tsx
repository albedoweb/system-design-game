import { Component, type ErrorInfo, type ReactNode } from 'react';

import './error-boundary.css';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled interface error', error, info);
  }

  private readonly handleRetry = (): void => {
    this.setState({ hasError: false });
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <main className="error-page">
          <div className="error-card" role="alert">
            <p className="error-eyebrow">Interface error</p>
            <h1>Something went wrong</h1>
            <p>
              The screen could not be rendered. Try opening it again — data in
              the browser was not changed.
            </p>
            <button type="button" onClick={this.handleRetry}>
              Try again
            </button>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}
