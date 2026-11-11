import { useId, useRef, useState } from 'react';

interface TextFieldProps {
  label: string;
  value: string;
  maxLength?: number;
  hint?: string;
  disabled?: boolean;
  onCommit: (value: string) => void;
}

export function TextField({
  label,
  value,
  maxLength = 80,
  hint,
  disabled,
  onCommit,
}: TextFieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const [draft, setDraft] = useState<string | null>(null);
  const skipCommit = useRef(false);
  const shown = draft ?? value;

  const commit = () => {
    if (skipCommit.current) {
      skipCommit.current = false;
      setDraft(null);
      return;
    }
    if (draft === null) {
      return;
    }
    const next = draft.trim();
    setDraft(null);
    if (next.length === 0) {
      return;
    }
    if (next !== value) {
      onCommit(next);
    }
  };

  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="ui-input"
        type="text"
        value={shown}
        maxLength={maxLength}
        disabled={disabled}
        aria-describedby={hintId}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            skipCommit.current = true;
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
      {hint ? (
        <p className="ui-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
