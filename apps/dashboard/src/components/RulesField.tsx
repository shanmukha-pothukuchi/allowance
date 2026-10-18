/**
 * An agent's owner rules (§20.3), in its sheet: take profit, stop loss, cash out profits above $X.
 * Each is saved on the scheduler as an owner schedule the agent can't change. A Linear settings
 * group: one row per rule, a small input at the end, empty means off, one quiet Save.
 */
import { useEffect, useState } from "react";
import { checkRules, sameRules, type AgentRules } from "../invest";
import type { AgentPublic } from "../types";
import { Check } from "./Icons";
import { Field } from "./SheetParts";

interface Props {
  agent: Pick<AgentPublic, "id" | "name">;
  /** The rules as the scheduler has them; undefined while it hasn't answered. */
  current: AgentRules | undefined;
  /** The scheduler isn't answering. */
  unavailable?: string;
  onSave(rules: AgentRules): Promise<void>;
}

type Draft = Required<{ [K in keyof AgentRules]: string }>;
const draftOf = (r: AgentRules | undefined): Draft => ({ takeProfitPct: r?.takeProfitPct ?? "", stopLossPct: r?.stopLossPct ?? "", cashOutAbove: r?.cashOutAbove ? r.cashOutAbove.replace(/\.00$/, "") : "" });

const ROWS: { key: keyof AgentRules; title: string; meta: string; unit: "%" | "$" }[] = [
  { key: "takeProfitPct", title: "Take profit", meta: "Sells a position that's up", unit: "%" },
  { key: "stopLossPct", title: "Stop loss", meta: "Sells a position that's down", unit: "%" },
  { key: "cashOutAbove", title: "Cash out profits", meta: "Sends you realized profit above", unit: "$" },
];

export function RulesField({ agent, current, unavailable, onSave }: Props) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(current));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  // Follow the scheduler until the owner starts typing.
  const key = JSON.stringify(current ?? null);
  useEffect(() => {
    if (!dirty) setDraft(draftOf(current));
  }, [key]); // `current` by value: the poll hands a new object every few seconds
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(t);
  }, [saved]);

  const check = checkRules(draft);
  const changed = check.ok && !sameRules(check.rules, current ?? {});
  const save = async () => {
    if (!check.ok) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSave(check.rules);
      setDirty(false);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field label="Rules" aside={unavailable ? undefined : "Empty is off"}>
      <ul className="ln-group rules-group" aria-label={`${agent.name}'s rules`}>
        {ROWS.map((r) => {
          const bad = !check.ok ? check.errors[r.key] : undefined;
          return (
            <li key={r.key} className="grow rule-row">
              <span className="grow-main">
                <label className="grow-title" htmlFor={`rule-${r.key}`}>
                  {r.title}
                </label>
                <span className="grow-meta">{bad ?? r.meta}</span>
              </span>
              <span className={`money-input rule-input${bad ? " input-bad" : ""}`}>
                {r.unit === "$" && <span aria-hidden>$</span>}
                {r.key === "stopLossPct" && <span aria-hidden>−</span>}
                {r.key === "takeProfitPct" && <span aria-hidden>+</span>}
                <input
                  id={`rule-${r.key}`}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="off"
                  value={draft[r.key]}
                  disabled={!!unavailable || current === undefined}
                  aria-invalid={!!bad}
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, [r.key]: e.target.value }));
                    setDirty(true);
                    setSaved(false);
                  }}
                />
                {r.unit === "%" && <span aria-hidden>%</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="rules-foot">
        <span className="rules-note" role="status">
          {unavailable ? (
            unavailable
          ) : error ? (
            <span className="field-error">{error}</span>
          ) : saved ? (
            <>
              <Check width={13} height={13} /> Saved on the scheduler
            </>
          ) : (
            ""
          )}
        </span>
        <button type="button" className="btn btn-sm" onClick={() => void save()} disabled={busy || !changed || !!unavailable}>
          {busy ? "Saving…" : "Save rules"}
        </button>
      </div>
    </Field>
  );
}
