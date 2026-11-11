import { useEffect, useId, useRef, type ReactNode } from 'react';

import { Button } from './Button';

interface ModalProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
}

export function Modal({ title, children, onClose, footer }: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    const focusTarget =
      panelRef.current?.querySelector<HTMLElement>(
        '.ui-modal__body select, .ui-modal__body input, .ui-modal__body textarea, .ui-modal__body button, .ui-modal__footer button',
      ) ??
      panelRef.current?.querySelector<HTMLElement>(
        'select, input, textarea, button, [tabindex]:not([tabindex="-1"])',
      );
    focusTarget?.focus();
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return (
    <div className="ui-modal-layer">
      <div className="ui-modal-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="ui-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
      >
        <div className="ui-modal__head">
          <h2 id={titleId}>{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        <div className="ui-modal__body">{children}</div>
        {footer ? <div className="ui-modal__footer">{footer}</div> : null}
      </div>
    </div>
  );
}
