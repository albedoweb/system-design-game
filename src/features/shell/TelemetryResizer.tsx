import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';

import {
  MIN_TELEMETRY_HEIGHT,
  clampTelemetryHeight,
  telemetryBounds,
  type TelemetryBounds,
} from './telemetry-layout';

const KEYBOARD_STEP = 24;

function boundsFor(container: HTMLElement | null): TelemetryBounds {
  if (!container) {
    return { min: MIN_TELEMETRY_HEIGHT, max: MIN_TELEMETRY_HEIGHT };
  }
  const style = getComputedStyle(container);
  const parsed = Number.parseFloat(style.rowGap || style.gap || '8');
  return telemetryBounds(
    container.clientHeight,
    Number.isFinite(parsed) ? parsed : 8,
  );
}

export function TelemetryResizer({
  containerRef,
  panelRef,
  height,
  onChange,
  onCommit,
  onResizeStart,
  onResizeEnd,
}: {
  containerRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  height: number | null;
  onChange: (height: number) => void;
  onCommit: (height: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
}) {
  const [observedHeight, setObservedHeight] = useState<number | null>(null);
  const [bounds, setBounds] = useState<TelemetryBounds>({
    min: MIN_TELEMETRY_HEIGHT,
    max: MIN_TELEMETRY_HEIGHT,
  });
  const heightRef = useRef<number | null>(height);
  const frameRef = useRef<number | null>(null);
  const pendingHeightRef = useRef<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    element: HTMLElement;
  } | null>(null);

  useEffect(() => {
    heightRef.current = height;
  }, [height]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const measure = () => {
      if (heightRef.current !== null) {
        return;
      }
      const next = panel.getBoundingClientRect().height;
      setObservedHeight((current) =>
        current !== null && Math.abs(current - next) < 0.5 ? current : next,
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [panelRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const update = () =>
      setBounds((current) => {
        const next = boundsFor(container);
        return current.min === next.min && current.max === next.max
          ? current
          : next;
      });
    update();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef]);

  // Re-clamp a selected height when notices, viewport or side panels change
  // the available split height. Growing the window never forces a new height.
  useEffect(() => {
    if (height === null) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const apply = () => {
      const clamped = clampTelemetryHeight(height, boundsFor(container));
      if (clamped !== height) {
        onChange(clamped);
      }
    };
    apply();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(apply);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, height, onChange]);

  const clearDragLayout = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    container.classList.remove('is-telemetry-dragging');
    container.style.removeProperty('--telemetry-drag-height');
  }, [containerRef]);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      const drag = dragRef.current;
      if (drag?.element.hasPointerCapture(drag.pointerId)) {
        drag.element.releasePointerCapture(drag.pointerId);
      }
      dragRef.current = null;
      clearDragLayout();
    };
  }, [clearDragLayout]);

  const applyDragHeight = useCallback(
    (next: number) => {
      const container = containerRef.current;
      const drag = dragRef.current;
      if (!container || !drag) {
        return;
      }
      container.classList.add('is-telemetry-dragging');
      container.style.setProperty('--telemetry-drag-height', `${next}px`);
      drag.element.setAttribute('aria-valuenow', String(next));
      drag.element.setAttribute(
        'aria-valuetext',
        `${next} pixels of telemetry`,
      );
    },
    [containerRef],
  );

  // Do not publish a React state update for every pointer move: a new height
  // commit re-renders the workspace while React Flow's own ResizeObserver is
  // reacting to the same layout change, which produced ResizeObserver loop
  // notifications. During the drag write only a CSS variable on the split (a
  // layout-only mutation) and commit the React height once on release.
  const scheduleHeight = useCallback(
    (next: number) => {
      heightRef.current = next;
      pendingHeightRef.current = next;
      if (frameRef.current !== null) {
        return;
      }
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const pending = pendingHeightRef.current;
        pendingHeightRef.current = null;
        if (pending !== null) {
          applyDragHeight(pending);
        }
      });
    },
    [applyDragHeight],
  );

  const finishDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    dragRef.current = null;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    pendingHeightRef.current = null;
    if (drag.element.hasPointerCapture(drag.pointerId)) {
      drag.element.releasePointerCapture(drag.pointerId);
    }
    if (heightRef.current !== null) {
      onChange(heightRef.current);
      onCommit(heightRef.current);
    }
    clearDragLayout();
    onResizeEnd?.();
  }, [clearDragLayout, onChange, onCommit, onResizeEnd]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    event.preventDefault();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: height ?? observedHeight ?? MIN_TELEMETRY_HEIGHT,
      element,
    };
    onResizeStart?.();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const bounds = boundsFor(containerRef.current);
    const next = clampTelemetryHeight(
      drag.startHeight + (drag.startY - event.clientY),
      bounds,
    );
    scheduleHeight(next);
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    finishDrag();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const bounds = boundsFor(containerRef.current);
    const current = height ?? observedHeight ?? MIN_TELEMETRY_HEIGHT;
    let next: number;
    switch (event.key) {
      case 'ArrowUp':
        next = current + KEYBOARD_STEP;
        break;
      case 'ArrowDown':
        next = current - KEYBOARD_STEP;
        break;
      case 'Home':
        next = bounds.min;
        break;
      case 'End':
        next = bounds.max;
        break;
      default:
        return;
    }
    event.preventDefault();
    const clamped = clampTelemetryHeight(next, bounds);
    heightRef.current = clamped;
    onChange(clamped);
    onCommit(clamped);
  };

  const current = clampTelemetryHeight(
    height ?? observedHeight ?? MIN_TELEMETRY_HEIGHT,
    bounds,
  );

  return (
    <div
      className="telemetry-resizer"
      role="separator"
      aria-label="Resize canvas and telemetry"
      aria-orientation="horizontal"
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={current}
      aria-valuetext={`${current} pixels of telemetry`}
      tabIndex={0}
      title="Drag or use the arrow keys to resize the canvas and telemetry"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onKeyDown={onKeyDown}
    >
      <span className="telemetry-resizer__grip" aria-hidden="true" />
    </div>
  );
}
