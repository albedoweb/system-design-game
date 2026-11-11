import { useId, useRef, useState } from 'react';

interface NumberFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  hint?: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}

/**
 * Numeric field with a local text draft. An empty or non-numeric draft is never
 * committed; blur/Enter restores the last valid value, Escape cancels.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  hint,
  disabled,
  onCommit,
}: NumberFieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const [draft, setDraft] = useState<string | null>(null);
  const skipCommit = useRef(false);
  const shown = draft ?? String(value);

  const commit = () => {
    if (skipCommit.current) {
      skipCommit.current = false;
      setDraft(null);
      return;
    }
    if (draft === null) {
      return;
    }
    const parsed = Number(draft.replace(',', '.'));
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(null);
      return;
    }
    const next = Math.min(max, Math.max(min, Math.round(parsed / step) * step));
    setDraft(null);
    if (next !== value) {
      onCommit(next);
    }
  };

  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="ui-field__control">
        <input
          id={id}
          className="ui-input ui-input--number"
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          value={shown}
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
        {unit ? <span className="ui-field__unit">{unit}</span> : null}
      </div>
      {hint ? (
        <p className="ui-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
