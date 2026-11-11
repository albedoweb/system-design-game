import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={['ui-button', `ui-button--${variant}`, `ui-button--${size}`, className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {icon ? (
        <span className="ui-button__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}
