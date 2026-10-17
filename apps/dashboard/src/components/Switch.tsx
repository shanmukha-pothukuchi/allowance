interface Props {
  on: boolean;
  label: string;
  busy?: boolean;
  disabled?: boolean;
  onChange(next: boolean): void;
}

/** An iOS-style switch. A real button with role="switch", so keyboard and screen readers work. */
export function Switch({ on, label, busy = false, disabled = false, onChange }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-busy={busy}
      className={`switch${on ? " switch-on" : ""}${busy ? " switch-busy" : ""}`}
      disabled={disabled || busy}
      onClick={() => onChange(!on)}
    >
      <span className="switch-knob" />
    </button>
  );
}
