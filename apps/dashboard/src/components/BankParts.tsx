/** Capital One (§16, Nessie sandbox) building blocks: a statement and the bank tile. Receipt marks live in Lines.tsx. */
import { entryAmount, entryIn, entryTitle, KIND_LABEL, nessieStatus, statementDate, statusTone } from "../bank";
import type { BankStatementEntry } from "../types";
import { Bank } from "./Icons";

/** A soft tile with a bank building: Capital One, without borrowing its logo. */
export function BankTile({ size = "md" }: { size?: "xs" | "sm" | "md" | "lg" }) {
  return (
    <span className={`bank-tile bank-tile-${size}`} aria-hidden>
      <Bank />
    </span>
  );
}

/**
 * Statement rows as Nessie reports them: merchant, kind and date, signed amount. Nessie's own
 * status shows only when it isn't the settled one (pending, cancelled); settled is in the tooltip.
 */
export function StatementList({ entries, now, max = 8 }: { entries: BankStatementEntry[]; now: number; max?: number }) {
  const shown = entries.slice(0, max);
  return (
    <ul className="ln-list ln-group stmt-list">
      {shown.map((e) => {
        const tone = statusTone(e.status);
        const status = nessieStatus(e.status);
        return (
          <li key={e.id} className="ln-row ln-row-nolead">
            <span className="ln-lead" />
            <div className="ln-body">
              <p className="ln-text">
                <strong>{entryTitle(e)}</strong>
                <span className="ln-tail">
                  {" · "}
                  {KIND_LABEL[e.kind] ?? e.kind} · {statementDate(e.date, now)}
                </span>
              </p>
            </div>
            <span className="ln-end">
              {status && tone !== "done" && <span className={`ln-chip ln-chip-${tone === "void" ? "danger" : tone === "pending" ? "neutral" : "neutral"}`}>{status}</span>}
              <span className={`ln-amt ${entryIn(e) ? "amt-in" : "amt-out"}`} title={status ? `Nessie: ${status}` : undefined}>
                {entryAmount(e)}
              </span>
            </span>
          </li>
        );
      })}
      {entries.length > shown.length && <li className="ln-more">+{entries.length - shown.length} older</li>}
    </ul>
  );
}
