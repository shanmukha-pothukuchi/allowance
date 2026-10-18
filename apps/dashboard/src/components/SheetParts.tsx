/** Building blocks shared by the owner sheets: the frame (dashboard panel or chat embed), amounts, copy. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AMOUNT_CHIPS, shortMoney } from "../sheets";
import { Check, Close, Lock } from "./Icons";

interface ShellProps {
  /** Embedded in the chat: a card on a transparent page, no backdrop. Else a right-hand sheet. */
  embed: boolean;
  label: string;
  head: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Close is blocked (a request is in flight, or a one-time token is on screen). */
  locked?: boolean;
  onClose(): void;
}

export function SheetShell({ embed, label, head, children, footer, locked = false, onClose }: ShellProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !locked && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose, locked]);

  const close = (
    <button type="button" className="icon-btn sheet-close" onClick={onClose} disabled={locked} aria-label="Close" title={locked ? "Finish first" : "Close"}>
      <Close width={18} height={18} />
    </button>
  );

  if (embed) {
    return (
      <div className="esheet" role="dialog" aria-label={label}>
        <div className="esheet-card">
          <header className="osheet-head">
            {head}
            {close}
          </header>
          <div className="osheet-body">{children}</div>
          {footer && <footer className="osheet-foot">{footer}</footer>}
        </div>
        <p className="embed-foot">
          <Lock width={12} height={12} /> Allowance wallet · only you can do this
        </p>
      </div>
    );
  }
  return (
    <>
      <div className="sheet-backdrop" onClick={() => !locked && onClose()} aria-hidden />
      <aside className="sheet osheet" role="dialog" aria-modal="true" aria-label={label}>
        <header className="sheet-head osheet-head">
          {head}
          {close}
        </header>
        <div className="sheet-body osheet-body">{children}</div>
        {footer && <footer className="osheet-foot">{footer}</footer>}
      </aside>
    </>
  );
}

/** Facts as label / value rows, like Linear's properties panel. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A labeled block inside a sheet. */
export function Field({ label, hint, htmlFor, children, aside }: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="ofield">
      <div className="ofield-label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <h3>{label}</h3>}
        {aside && <span className="ofield-aside">{aside}</span>}
      </div>
      {children}
      {hint && <div className="ofield-hint">{hint}</div>}
    </section>
  );
}

export const CUSTOM = "custom";

interface AmountProps {
  id: string;
  /** A chip amount ("20.00") or "custom". */
  choice: string;
  custom: string;
  error?: string;
  label: string;
  onChoice(choice: string): void;
  onCustom(raw: string): void;
}

/** $5 / $10 / $20 / $50 / Custom, and a dollar input for Custom. */
export function AmountPicker({ id, choice, custom, error, label, onChoice, onCustom }: AmountProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="amount-picker">
      <div className="chips amount-chips" role="radiogroup" aria-label={label}>
        {AMOUNT_CHIPS.map((a) => (
          <button key={a} type="button" role="radio" aria-checked={choice === a} className={`chip amount-chip${choice === a ? " chip-on" : ""}`} onClick={() => onChoice(a)}>
            {shortMoney(a)}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={choice === CUSTOM}
          className={`chip amount-chip${choice === CUSTOM ? " chip-on" : ""}`}
          onClick={() => {
            onChoice(CUSTOM);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        >
          Custom
        </button>
      </div>
      {choice === CUSTOM && (
        <div className={`money-input${error ? " input-bad" : ""}`}>
          <span aria-hidden>$</span>
          <input
            ref={inputRef}
            id={id}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={custom}
            aria-label={`${label}, custom amount in dollars`}
            aria-invalid={!!error}
            onChange={(e) => onCustom(e.target.value)}
          />
        </div>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Text the owner must copy (a one-time token, an address). The clipboard API needs a permission an
 * iframe may not have, so fall back to selecting the text and execCommand, then to "press Ctrl+C".
 */
export function CopyField({ value, label, secret = false }: { value: string; label: string; secret?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  useEffect(() => {
    if (state !== "copied") return;
    const t = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(t);
  }, [state]);

  const select = () => {
    const el = ref.current;
    const sel = typeof getSelection === "function" ? getSelection() : null;
    if (el && sel) sel.selectAllChildren(el);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
      return;
    } catch {
      /* no clipboard permission (iframe) */
    }
    select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    setState(ok ? "copied" : "manual");
  };

  return (
    <div className="copy-field">
      <code ref={ref} className={`copy-value${secret ? " copy-secret" : ""}`} aria-label={label} onClick={select} translate="no" spellCheck={false}>
        {value}
      </code>
      <button type="button" className={`btn copy-btn${state === "copied" ? " copy-done" : ""}`} onClick={() => void copy()}>
        {state === "copied" ? (
          <>
            <Check width={15} height={15} /> Copied
          </>
        ) : (
          "Copy"
        )}
      </button>
      {state === "manual" && <span className="copy-manual">Selected. Press Ctrl+C (⌘C) to copy.</span>}
    </div>
  );
}
